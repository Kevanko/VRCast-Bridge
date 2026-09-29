using System.Runtime.InteropServices;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

// Темп потока задаётся настенными часами: каждый тик выводится ровно столько
// кадров, сколько должно было пройти по Stopwatch, недостающее добивается
// тишиной. Это одновременно чинит два бага: (1) фиксированный «блок за тик»
// давал ~95% реального времени (таймер Windows тикает реже 20мс) — звук заикался
// и глох; (2) чисто событийная запись молчала при тишине источника — ffmpeg
// вечно ждал первые байты и эфир вообще не стартовал.
const int sampleRate = 48000;
// Сообщения в stderr сервер читает как UTF-8.
Console.OutputEncoding = System.Text.Encoding.UTF8;

if (args.Contains("--list-devices", StringComparer.OrdinalIgnoreCase))
{
    using var enumerator = new MMDeviceEnumerator();
    string? main = null;
    try { using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia); main = device.ID; } catch { }
    Console.WriteLine(JsonSerializer.Serialize(enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
        .Select(device => new { id = device.ID, name = device.FriendlyName, isDefault = device.ID == main }).ToArray()));
    return;
}

// Вернуть звук приложениям, которые остались уведёнными на беззвучный выход
// после аварийного завершения (помощник убили — Dispose не успел).
if (args.Contains("--unroute-pending", StringComparer.OrdinalIgnoreCase))
{
    AppRouting.RestorePending();
    return;
}

// Сервер закрывает stdin, когда пора остановиться. Это единственный способ
// завершиться штатно: при принудительном убийстве Windows не даёт восстановить
// громкость приложения, и оно осталось бы тихим после эфира.
// Диагностика: какая сейчас громкость у сессий приложения в микшере Windows.
// Нужна, чтобы проверять «тише у себя» не на слух, а по числу.
if (args.Contains("--session-volume", StringComparer.OrdinalIgnoreCase))
{
    var индекс = Array.FindIndex(args, value => value.Equals("--session-volume", StringComparison.OrdinalIgnoreCase));
    var значение = индекс >= 0 && индекс + 1 < args.Length ? args[индекс + 1] : string.Empty;
    var target = uint.TryParse(значение, out var wanted) ? wanted : 0;
    using var probe = new MMDeviceEnumerator();
    using var endpoint = probe.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    var list = endpoint.AudioSessionManager.Sessions;
    for (var index = 0; index < list.Count; index++)
    {
        var session = list[index];
        if (session.GetProcessID != target) continue;
        Console.WriteLine($"volume={session.SimpleAudioVolume.Volume:F3} mute={session.SimpleAudioVolume.Mute}");
    }
    return;
}

string? ValueAfter(string option)
{
    var index = Array.FindIndex(args, value => value.Equals(option, StringComparison.OrdinalIgnoreCase));
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

var shutdown = new CancellationTokenSource();
SessionMuter? localSession = null;
AudioControl.StreamGain = float.TryParse(ValueAfter("--stream-gain"), System.Globalization.NumberStyles.Float,
    System.Globalization.CultureInfo.InvariantCulture, out var initialGain) ? Math.Clamp(initialGain, 0f, 6f) : 1f;
var requestedLocalLevel = float.TryParse(ValueAfter("--local-volume"), System.Globalization.NumberStyles.Float,
    System.Globalization.CultureInfo.InvariantCulture, out var initialLocal) ? Math.Clamp(initialLocal, 0.02f, 1f) : 1f;
var requestedLocalMute = args.Contains("--local-mute", StringComparer.OrdinalIgnoreCase);

// stdin — не только сигнал завершения, но и канал горячих настроек. Так
// громкость эфира и локальное приглушение меняются без остановки WASAPI и без
// единого пропущенного аудиоблока.
_ = Task.Run(async () =>
{
    try
    {
        using var input = new StreamReader(Console.OpenStandardInput());
        while (await input.ReadLineAsync() is { } line)
        {
            var parts = line.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 2) continue;
            if (parts[0].Equals("stream-gain", StringComparison.OrdinalIgnoreCase)
                && float.TryParse(parts[1], System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var gain))
                AudioControl.StreamGain = Math.Clamp(gain, 0f, 6f);
            else if (parts[0].Equals("local-volume", StringComparison.OrdinalIgnoreCase)
                && float.TryParse(parts[1], System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var level))
                localSession?.Update(Math.Clamp(level, 0.02f, 1f), localSession.Muted);
            else if (parts[0].Equals("local-mute", StringComparison.OrdinalIgnoreCase))
                localSession?.Update(localSession.Level, parts[1] is "1" or "true" or "on");
        }
    }
    catch { }
    shutdown.Cancel();
});

var pidText = ValueAfter("--pid");
if (args.Contains("--silence", StringComparer.OrdinalIgnoreCase))
{
    var silenceOutput = Console.OpenStandardOutput();
    var zeros = new byte[sampleRate * 4 / 2];
    var silenceClock = System.Diagnostics.Stopwatch.StartNew();
    long silenceFrames = 0;
    try
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(20));
        while (await timer.WaitForNextTickAsync(shutdown.Token))
        {
            var expected = (long)(silenceClock.Elapsed.TotalSeconds * sampleRate);
            var due = Math.Min(sampleRate / 2, expected - silenceFrames);
            if (due <= 0) continue;
            await silenceOutput.WriteAsync(zeros.AsMemory(0, checked((int)due * 4)), shutdown.Token);
            silenceFrames += due;
        }
    }
    catch (IOException) { }
    catch (OperationCanceledException) { }
    return;
}

if (uint.TryParse(pidText, out var processId) && processId > 0)
{
    // Захват процесса идёт ПОСЛЕ громкости сессии Windows. Приглушение у себя
    // SessionMuter делает уровнем, а потерю в эфире компенсирует усилением.
    using var localMute = args.Contains("--local-volume", StringComparer.OrdinalIgnoreCase)
        ? new SessionMuter(processId, requestedLocalLevel, requestedLocalMute, ValueAfter("--route-device")) : null;
    localSession = localMute;
    try { await ProcessLoopback.RunAsync(processId, Console.OpenStandardOutput(), shutdown.Token); }
    // Не Environment.Exit: он завершал процесс прямо внутри using, Dispose
    // не вызывался, и приложение оставалось тихим (или заглушённым) после сбоя.
    // Код выхода ставим, а выходим обычным путём — громкость вернётся в Dispose.
    catch (Exception error) { Console.Error.WriteLine($"Process loopback failed: {error.Message}"); Environment.ExitCode = 1; }
    return;
}

var deviceId = ValueAfter("--device-id");
using var deviceEnumerator = new MMDeviceEnumerator();
// «Весь рабочий стол» = дефолтное устройство вывода. При смене дефолта
// (наушники, HDMI, гарнитура) захват пересоздаётся на лету: единый Stopwatch
// продолжает пейсинг, поэтому поток PCM не прерывается и не сдвигается.
var defaultChanged = 0;
DeviceWatcher? watcher = null;
if (string.IsNullOrWhiteSpace(deviceId))
{
    watcher = new DeviceWatcher(() => Interlocked.Exchange(ref defaultChanged, 1));
    deviceEnumerator.RegisterEndpointNotificationCallback(watcher);
}
var output = Console.OpenStandardOutput();
var outputBuffer = new byte[sampleRate * 2];
var clock = System.Diagnostics.Stopwatch.StartNew();
long framesWritten = 0;
var streaming = true;
while (streaming)
{
    MMDevice? selectedDevice = null;
    WasapiLoopbackCapture capture;
    try
    {
        selectedDevice = string.IsNullOrWhiteSpace(deviceId) ? null : deviceEnumerator.GetDevice(deviceId);
        capture = selectedDevice is null ? new WasapiLoopbackCapture() : new WasapiLoopbackCapture(selectedDevice);
    }
    catch (Exception error)
    {
        Console.Error.WriteLine($"Loopback device unavailable: {error.Message}");
        break;
    }
    var buffer = new BufferedWaveProvider(capture.WaveFormat) { BufferDuration = TimeSpan.FromMilliseconds(400), DiscardOnBufferOverflow = true, ReadFully = true };
    capture.DataAvailable += (_, eventArgs) => buffer.AddSamples(eventArgs.Buffer, 0, eventArgs.BytesRecorded);
    capture.RecordingStopped += (_, eventArgs) =>
    {
        if (eventArgs.Exception is not null) Console.Error.WriteLine($"Loopback capture stopped: {eventArgs.Exception.Message}");
    };
    ISampleProvider samples = buffer.ToSampleProvider();
    if (samples.WaveFormat.Channels == 1) samples = new MonoToStereoSampleProvider(samples);
    else if (samples.WaveFormat.Channels > 2) samples = new MultiplexingSampleProvider(new[] { samples }, 2);
    if (samples.WaveFormat.SampleRate != sampleRate) samples = new WdlResamplingSampleProvider(samples, sampleRate);
    samples = new DynamicGainSampleProvider(samples);
    var pcm = new SampleToWaveProvider16(samples);
    var deviceSwap = false;
    capture.StartRecording();
    try
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(20));
        while (await timer.WaitForNextTickAsync(shutdown.Token))
        {
            if (Interlocked.Exchange(ref defaultChanged, 0) == 1) { deviceSwap = true; break; }
            var expected = (long)(clock.Elapsed.TotalSeconds * sampleRate);
            var due = expected - framesWritten;
            if (due <= 0) continue;
            if (due > sampleRate / 2) { framesWritten = expected - sampleRate / 2; due = sampleRate / 2; }
            var bytes = (int)(due * 4);
            var read = pcm.Read(outputBuffer, 0, bytes);
            if (read > 0) { await output.WriteAsync(outputBuffer.AsMemory(0, read)); framesWritten += read / 4; }
        }
    }
    catch (IOException) { streaming = false; }
    catch (OperationCanceledException) { streaming = false; }
    finally
    {
        capture.StopRecording(); capture.Dispose(); selectedDevice?.Dispose();
    }
    if (!deviceSwap) break;
    Console.Error.WriteLine("Default output device changed, reattaching loopback");
    await Task.Delay(250);
}
if (watcher is not null) deviceEnumerator.UnregisterEndpointNotificationCallback(watcher);

internal sealed class DeviceWatcher(Action onDefaultChanged) : NAudio.CoreAudioApi.Interfaces.IMMNotificationClient
{
    public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        if (flow == DataFlow.Render && role == Role.Multimedia) onDefaultChanged();
    }
    public void OnDeviceAdded(string deviceId) { }
    public void OnDeviceRemoved(string deviceId) { }
    public void OnDeviceStateChanged(string deviceId, DeviceState newState) { }
    public void OnPropertyValueChanged(string deviceId, NAudio.CoreAudioApi.PropertyKey key) { }
}

internal static class ProcessLoopback
{
    private const string VirtualDevice = "VAD\\Process_Loopback";
    private const ushort VtBlob = 65;
    private const int ActivationProcessLoopback = 1;
    private const uint StreamFlagsLoopback = 0x00020000;
    private const uint StreamFlagsAutoConvertPcm = 0x80000000;
    private const uint StreamFlagsSrcDefaultQuality = 0x08000000;
    private static readonly Guid AudioClientId = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid CaptureClientId = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    internal static async Task RunAsync(uint processId, Stream output, CancellationToken token)
    {
        var activation = new AudioClientActivationParams
        {
            ActivationType = ActivationProcessLoopback,
            ProcessLoopbackParams = new ProcessLoopbackParams { TargetProcessId = processId, ProcessLoopbackMode = 0 }
        };
        var activationPointer = Marshal.AllocHGlobal(Marshal.SizeOf<AudioClientActivationParams>());
        Marshal.StructureToPtr(activation, activationPointer, false);
        var variant = new PropVariant { VariantType = VtBlob, Blob = new Blob { Size = Marshal.SizeOf<AudioClientActivationParams>(), Data = activationPointer } };
        var completion = new ActivationHandler();
        try
        {
            var iid = AudioClientId;
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync(VirtualDevice, ref iid, ref variant, completion, out var operation));
            var client = await completion.Task.WaitAsync(TimeSpan.FromSeconds(8));
            await CaptureAsync(client, output, token);
            GC.KeepAlive(operation);
        }
        finally { Marshal.FreeHGlobal(activationPointer); }
    }

    private static async Task CaptureAsync(IAudioClient client, Stream output, CancellationToken token)
    {
        // Виртуальное process-loopback устройство не обязано отдавать IEEE
        // float: на части Windows Initialize формально успешен, но пакеты затем
        // приходят как вечная тишина. Официальный Microsoft sample запрашивает
        // обычный PCM16 — используем тот же совместимый формат.
        var format = new WaveFormatEx { FormatTag = 1, Channels = 2, SamplesPerSec = 48000, AvgBytesPerSec = 384000, BlockAlign = 8, BitsPerSample = 32, ExtraSize = 0 };
        var formatPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormatEx>());
        Marshal.StructureToPtr(format, formatPointer, false);
        try
        {
            Marshal.ThrowExceptionForHR(client.Initialize(0, StreamFlagsLoopback | StreamFlagsAutoConvertPcm | StreamFlagsSrcDefaultQuality, 200_000, 0, formatPointer, IntPtr.Zero));
            var serviceId = CaptureClientId;
            Marshal.ThrowExceptionForHR(client.GetService(ref serviceId, out var service));
            var capture = (IAudioCaptureClient)service;
            Marshal.ThrowExceptionForHR(client.Start());
            try
            {
                // Каждый тик: выгребаем все пакеты в кольцевой буфер, затем выводим
                // ровно столько кадров, сколько положено по настенным часам —
                // недостающее уходит тишиной, чтобы поток не замирал при паузах звука.
                var ring = new PcmRingBuffer(192000 * 400 / 1000);
                // Два буфера на весь сеанс вместо новых на каждый пакет:
                // в звуковом тракте пауза сборщика мусора слышна сразу.
                byte[] packet = new byte[32768];
                byte[] pcm16 = new byte[16384];
                var outputBlock = new byte[48000 * 2];
                var clock = System.Diagnostics.Stopwatch.StartNew();
                long framesWritten = 0;
                using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(10));
                while (await timer.WaitForNextTickAsync(token))
                {
                    Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out var frames));
                    while (frames > 0)
                    {
                        Marshal.ThrowExceptionForHR(capture.GetBuffer(out var data, out frames, out var flags, out _, out _));
                        var нужноБайт = checked((int)frames * 8);
                        if (packet.Length < нужноБайт) { packet = new byte[нужноБайт]; pcm16 = new byte[нужноБайт / 2]; }
                        if ((flags & 2) == 0 && data != IntPtr.Zero) Marshal.Copy(data, packet, 0, нужноБайт);
                        else Array.Clear(packet, 0, нужноБайт);
                        Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames));
                        // 32 бита, а не 16: при «не слышать у себя» приложение
                        // звучит на −60 дБ, и в 16 битах от сигнала остались бы
                        // единицы разрядов. В 32 битах усиление обратно чистое,
                        // а в 16 бит переводим уже на полной громкости.
                        var gain = AudioControl.StreamGain / AudioControl.LocalLevel / 65536f;
                        for (int from = 0, to = 0; from < нужноБайт; from += 4, to += 2)
                        {
                            var value = Math.Clamp((int)MathF.Round(BitConverter.ToInt32(packet, from) * gain), short.MinValue, short.MaxValue);
                            pcm16[to] = (byte)(value & 0xFF);
                            pcm16[to + 1] = (byte)((value >> 8) & 0xFF);
                        }
                        ring.Write(pcm16.AsSpan(0, нужноБайт / 2));
                        Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out frames));
                    }
                    var expected = (long)(clock.Elapsed.TotalSeconds * 48000);
                    var due = expected - framesWritten;
                    if (due <= 0) continue;
                    if (due > 24000) { framesWritten = expected - 24000; due = 24000; }
                    var blockBytes = (int)(due * 4);
                    Array.Clear(outputBlock, 0, blockBytes);
                    ring.Read(outputBlock.AsSpan(0, blockBytes));
                    await output.WriteAsync(outputBlock.AsMemory(0, blockBytes));
                    framesWritten += due;
                }
            }
            catch (IOException) { }
            catch (OperationCanceledException) { }
            finally { client.Stop(); if (Marshal.IsComObject(service)) Marshal.ReleaseComObject(service); }
        }
        finally { Marshal.FreeHGlobal(formatPointer); if (Marshal.IsComObject(client)) Marshal.ReleaseComObject(client); }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath, ref Guid riid,
        ref PropVariant activationParams, IActivateAudioInterfaceCompletionHandler completionHandler, out IActivateAudioInterfaceAsyncOperation operation);

    [StructLayout(LayoutKind.Sequential)] private struct ProcessLoopbackParams { public uint TargetProcessId; public int ProcessLoopbackMode; }
    [StructLayout(LayoutKind.Sequential)] private struct AudioClientActivationParams { public int ActivationType; public ProcessLoopbackParams ProcessLoopbackParams; }
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Size; public IntPtr Data; }
    [StructLayout(LayoutKind.Explicit)] private struct PropVariant { [FieldOffset(0)] public ushort VariantType; [FieldOffset(8)] public Blob Blob; }
    [StructLayout(LayoutKind.Sequential, Pack = 2)] private struct WaveFormatEx { public ushort FormatTag, Channels; public uint SamplesPerSec, AvgBytesPerSec; public ushort BlockAlign, BitsPerSample, ExtraSize; }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation { [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface); }
    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler { [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation); }
    private sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler
    {
        private readonly TaskCompletionSource<IAudioClient> _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Task<IAudioClient> Task => _completion.Task;
        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try { Marshal.ThrowExceptionForHR(operation.GetActivateResult(out var result, out var instance)); Marshal.ThrowExceptionForHR(result); _completion.TrySetResult((IAudioClient)instance); }
            catch (Exception error) { _completion.TrySetException(error); }
            return 0;
        }
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames); [PreserveSig] int GetStreamLatency(out long latency); [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch); [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod); [PreserveSig] int Start(); [PreserveSig] int Stop(); [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle); [PreserveSig] int GetService(ref Guid serviceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames); [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}

internal sealed class PcmRingBuffer
{
    private readonly byte[] _buffer;
    private int _read;
    private int _count;

    internal PcmRingBuffer(int capacity) => _buffer = new byte[Math.Max(3840, capacity)];

    internal void Write(ReadOnlySpan<byte> source)
    {
        if (source.Length >= _buffer.Length)
        {
            source = source[^_buffer.Length..];
            _read = 0;
            _count = 0;
        }
        var overflow = Math.Max(0, _count + source.Length - _buffer.Length);
        _read = (_read + overflow) % _buffer.Length;
        _count -= overflow;
        var write = (_read + _count) % _buffer.Length;
        var first = Math.Min(source.Length, _buffer.Length - write);
        source[..first].CopyTo(_buffer.AsSpan(write));
        source[first..].CopyTo(_buffer);
        _count += source.Length;
    }

    internal int Read(Span<byte> destination)
    {
        var length = Math.Min(destination.Length, _count);
        var first = Math.Min(length, _buffer.Length - _read);
        _buffer.AsSpan(_read, first).CopyTo(destination);
        _buffer.AsSpan(0, length - first).CopyTo(destination[first..]);
        _read = (_read + length) % _buffer.Length;
        _count -= length;
        return length;
    }
}

internal static class AudioControl
{
    internal static volatile float StreamGain = 1f;
    // Во сколько раз приложение приглушено у пользователя: захват идёт после
    // этого регулятора, и в эфире потерю возвращаем усилением.
    internal static volatile float LocalLevel = 1f;
}

internal sealed class DynamicGainSampleProvider(ISampleProvider source) : ISampleProvider
{
    public WaveFormat WaveFormat => source.WaveFormat;

    public int Read(float[] buffer, int offset, int count)
    {
        var read = source.Read(buffer, offset, count);
        var gain = AudioControl.StreamGain;
        for (var index = offset; index < offset + read; index++)
            buffer[index] = Math.Clamp(buffer[index] * gain, -1f, 1f);
        return read;
    }
}

// Глушит звук выбранного приложения только на этом компьютере: в эфир он идёт
// как был. Нужно, чтобы в наушниках не двоился звук — свой напрямую и он же
// с задержкой из VRChat. Сессии перепроверяются: приложение может создать
// новые (браузеры и плееры часто выводят звук из дочерних процессов).
internal sealed class SessionMuter : IDisposable
{
    private readonly uint _processId;
    private readonly string _processName;
    private float _level;
    private bool _mute;
    // Исходные громкость и мьют каждой сессии — по одному разу, при первом
    // касании: раньше помнилась только громкость, а снятый мьют не возвращался,
    // и повторные касания той же сессии дописывали в список уже наш уровень.
    private readonly Dictionary<string, (SimpleAudioVolume Volume, float Level, bool Mute)> _muted = new();
    private bool _disposed;
    private readonly Timer _watch;
    private readonly MMDeviceEnumerator _enumerator = new();
    // «Не слышать у себя» по-настоящему: сессии приложения уводятся на
    // беззвучный виртуальный выход (как «Параметры → Громкость приложений»).
    // В наушники не идёт ничего, а захват процесса от выхода не зависит —
    // в эфир звук идёт как шёл (замер на Edge: увод на Steam Streaming, захват
    // не изменился). Нет такого выхода — остаётся приглушение до −60 дБ.
    private readonly string? _silentDevice;
    private readonly HashSet<uint> _routed = new();

    internal float Level => _level;
    internal bool Muted => _mute;
    // Захват процесса идёт ПОСЛЕ регулятора громкости сессии (проверено: 10% у
    // себя = −20 дБ в эфире, мьют = тишина в эфире). Поэтому «не слышать у себя»
    // — это не мьют, а минимальная громкость, которую помощник компенсирует
    // усилением. −60 дБ у себя — на слух тишина; захват 32-битный, так что
    // в эфир звук возвращается без потери разрядов (замер: шум не вырос).
    internal const float MinLevel = 0.001f;
    // Звук уведён на беззвучный выход — громкость не трогаем вовсе: это
    // настоящее выключение, а не затухание. Приглушение — только запасной путь.
    private bool _routingBroken;
    private float Effective => _mute && (_silentDevice is null || _routingBroken) ? MinLevel : _level;

    internal SessionMuter(uint processId, float level, bool mute, string? routeDevice = null)
    {
        _processId = processId;
        _level = level;
        _mute = mute;
        AudioControl.LocalLevel = Effective;
        try { _processName = System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; }
        catch { _processName = string.Empty; }
        // Выход, выбранный в настройках, — если он сейчас подключён; иначе
        // рекомендованный беззвучный.
        _silentDevice = AppRouting.Usable(_enumerator, routeDevice) ?? AppRouting.SilentDevice(_enumerator);
        Console.Error.WriteLine(_silentDevice is null
            ? "Беззвучного виртуального выхода нет — «не слышать у себя» приглушает до −60 дБ"
            : "«Не слышать у себя»: звук приложения уводится на беззвучный виртуальный выход");
        Apply();
        _watch = new Timer(_ => Apply(), null, 1000, 1000);
    }

    internal void Update(float level, bool mute)
    {
        _level = level;
        _mute = mute;
        AudioControl.LocalLevel = Effective;
        Apply();
    }

    private void Apply()
    {
        // Смотрим все активные выходы, а не только тот, что стоит по умолчанию.
        // Приложение вполне может играть в гарнитуру или в HDMI-монитор — тогда
        // на устройстве по умолчанию его сессии просто нет, и громкость
        // «в наушниках» не менялась вообще ничем.
        // Компенсируем по РЕАЛЬНОЙ громкости приложения, а не по той, что сами
        // выставили: уходящий помощник при смене источника возвращал «исходную»
        // громкость поверх нового, и эфир становился то оглушительным (делили
        // на 0,35 при фактических 100%), то тихим.
        float? фактическая = null;
        try
        {
            if (!_mute) Unroute();
            foreach (var device in _enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                using (device)
                {
                    var sessions = device.AudioSessionManager.Sessions;
                    for (var index = 0; index < sessions.Count; index++)
                    {
                        var session = sessions[index];
                        if (!Matches(session)) continue;
                        // Уводим процесс, который реально играет звук: у браузеров
                        // это отдельный процесс аудиосервиса, а не главное окно.
                        var sessionPid = session.GetProcessID;
                        if (_mute && _silentDevice is not null && !_routingBroken && sessionPid != 0 && !_routed.Contains(sessionPid))
                        {
                            // Сначала записываем «вернуть», потом уводим: если помощник
                            // упадёт между этими шагами, звук вернётся при следующем запуске.
                            // Раньше было наоборот, и увод, совпавший с закрытием,
                            // оставлял приложение (Spotify) без звука навсегда.
                            if (_disposed) return;
                            AppRouting.RememberPending(_processName);
                            if (AppRouting.Set(sessionPid, _silentDevice))
                            {
                                bool поздно;
                                lock (_muted) { поздно = _disposed; if (!поздно) _routed.Add(sessionPid); }
                                if (поздно) { AppRouting.Set(sessionPid, null); return; }
                            }
                            else
                            {
                                _routingBroken = true;
                                AudioControl.LocalLevel = Effective;
                                Console.Error.WriteLine("Увести звук приложения не вышло — приглушаю до −60 дБ");
                            }
                        }
                        var volume = session.SimpleAudioVolume;
                        var mute = volume.Mute;
                        if (!mute && Math.Abs(volume.Volume - Effective) < 0.001f) { фактическая ??= volume.Volume; continue; }
                        lock (_muted)
                        {
                            if (_disposed) return;
                            var ключ = session.GetSessionInstanceIdentifier ?? $"{session.GetProcessID}";
                            if (!_muted.ContainsKey(ключ)) _muted[ключ] = (volume, volume.Volume, mute);
                            // Настоящий мьют глушит и захват — снимаем его всегда.
                            volume.Mute = false;
                            volume.Volume = Effective;
                            фактическая ??= volume.Volume;
                        }
                    }
                }
            }
        }
        catch { }
        if (фактическая is { } уровень && !_disposed) AudioControl.LocalLevel = Math.Max(0.001f, уровень);
    }

    // Имя процесса по его номеру запоминаем: раньше это спрашивалось у Windows
    // для каждой сессии каждого устройства раз в секунду, и для закрытых
    // программ каждый такой вопрос стоил исключения в горячем месте.
    private readonly Dictionary<uint, string> _names = new();

    private bool Matches(AudioSessionControl session)
    {
        try
        {
            var pid = session.GetProcessID;
            if (pid == _processId) return true;
            if (string.IsNullOrEmpty(_processName)) return false;
            if (!_names.TryGetValue(pid, out var имя))
            {
                try { имя = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
                catch { имя = string.Empty; }
                _names[pid] = имя;
            }
            return имя == _processName;
        }
        catch { return false; }
    }

    private void Unroute()
    {
        uint[] pids;
        lock (_muted) { pids = _routed.ToArray(); _routed.Clear(); }
        foreach (var pid in pids) AppRouting.Set(pid, null);
        if (pids.Length > 0) AppRouting.ForgetPending(_processName);
    }

    public void Dispose()
    {
        _watch.Dispose();
        Unroute();
        lock (_muted)
        {
            _disposed = true;
            foreach (var (volume, level, mute) in _muted.Values)
            {
                try { volume.Volume = level; } catch { }
                try { volume.Mute = mute; } catch { }
            }
            _muted.Clear();
        }
        _enumerator.Dispose();
    }
}

// Выход приложения по умолчанию задаётся тем же недокументированным API, что и
// «Параметры → Звук → Громкость приложений» (им же пользуются EarTrumpet и
// SoundSwitch). Любая ошибка — просто «не вышло»: тогда остаётся приглушение.
// Windows запоминает выбор для exe, поэтому уведённые приложения записываются
// в файл и возвращаются при следующем запуске, если помощник убили.
internal static class AppRouting
{
    private static IntPtr _factory;
    private static readonly string PendingFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "routed-apps.txt");

    internal static unsafe bool Set(uint pid, string? deviceId)
    {
        try
        {
            if (_factory == IntPtr.Zero)
            {
                const string name = "Windows.Media.Internal.AudioPolicyConfig";
                WindowsCreateString(name, name.Length, out var hName);
                var iid = Environment.OSVersion.Version.Build >= 21390
                    ? new Guid("ab3d4648-e242-459f-b02f-541c70306324") : new Guid("2a59116d-6c4f-45e0-a74f-707e3fef9258");
                var hr = RoGetActivationFactory(hName, ref iid, out _factory);
                WindowsDeleteString(hName);
                if (hr != 0) { _factory = IntPtr.Zero; return false; }
            }
            var full = string.IsNullOrEmpty(deviceId) ? "" : @"\\?\SWD#MMDEVAPI#" + deviceId + "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
            var hDevice = IntPtr.Zero;
            if (full.Length > 0) WindowsCreateString(full, full.Length, out hDevice);
            try
            {
                // IInspectable (6 методов) + 19 до SetPersistedDefaultAudioEndpoint.
                var set = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, int, IntPtr, int>)(*(IntPtr**)_factory)[25];
                var console = set(_factory, pid, 0, 0, hDevice);
                var multimedia = set(_factory, pid, 0, 1, hDevice);
                return console == 0 && multimedia == 0;
            }
            finally { if (hDevice != IntPtr.Zero) WindowsDeleteString(hDevice); }
        }
        catch { return false; }
    }

    // Только выход, который заведомо никто не слушает. «Virtual» в имени не
    // годится: так называются и настоящие гарнитуры (HyperX Virtual Surround).
    internal static string? Usable(MMDeviceEnumerator enumerator, string? deviceId)
    {
        if (string.IsNullOrEmpty(deviceId)) return null;
        try
        {
            using var main = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            if (deviceId == main.ID) return null;   // в свои же наушники уводить бессмысленно
            using var device = enumerator.GetDevice(deviceId);
            return device.State == DeviceState.Active ? device.ID : null;
        }
        catch { return null; }
    }

    internal static string? SilentDevice(MMDeviceEnumerator enumerator)
    {
        try
        {
            using var main = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
                using (device)
                    if (device.ID != main.ID && System.Text.RegularExpressions.Regex.IsMatch(device.FriendlyName,
                        "steam streaming|cable input|voicemeeter|vb-audio", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                        return device.ID;
        }
        catch { }
        return null;
    }

    internal static void RememberPending(string processName)
    {
        try
        {
            var names = File.Exists(PendingFile) ? File.ReadAllLines(PendingFile).ToHashSet() : new HashSet<string>();
            if (names.Add(processName)) File.WriteAllLines(PendingFile, names);
        }
        catch { }
    }

    internal static void ForgetPending(string processName)
    {
        try
        {
            if (!File.Exists(PendingFile)) return;
            var names = File.ReadAllLines(PendingFile).Where(name => name != processName).ToArray();
            if (names.Length == 0) File.Delete(PendingFile); else File.WriteAllLines(PendingFile, names);
        }
        catch { }
    }

    // Возврат выбора делается от имени любого процесса того же exe. Не запущено —
    // остаётся в списке до следующего раза.
    internal static void RestorePending()
    {
        try
        {
            if (!File.Exists(PendingFile)) return;
            foreach (var name in File.ReadAllLines(PendingFile).Where(name => name.Length > 0))
            {
                var any = System.Diagnostics.Process.GetProcessesByName(name);
                if (any.Length == 0) continue;
                // Снять выбор Windows даёт только процессу со звуковой сессией
                // (у браузера это аудиосервис), поэтому пробуем все.
                var снято = false;
                foreach (var process in any) снято |= Set((uint)process.Id, null);
                if (снято) ForgetPending(name);
            }
        }
        catch { }
    }

    [DllImport("combase.dll")] private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] private static extern int WindowsCreateString(string source, int length, out IntPtr hstring);
    [DllImport("combase.dll")] private static extern int WindowsDeleteString(IntPtr hstring);
}

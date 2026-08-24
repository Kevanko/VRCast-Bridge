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

if (args.Contains("--list-devices", StringComparer.OrdinalIgnoreCase))
{
    using var enumerator = new MMDeviceEnumerator();
    Console.WriteLine(JsonSerializer.Serialize(enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
        .Select(device => new { id = device.ID, name = device.FriendlyName }).ToArray()));
    return;
}

// Сервер закрывает stdin, когда пора остановиться. Это единственный способ
// завершиться штатно: при принудительном убийстве Windows не даёт восстановить
// громкость приложения, и оно осталось бы тихим после эфира.
var shutdown = new CancellationTokenSource();
_ = Task.Run(async () =>
{
    try
    {
        await using var input = Console.OpenStandardInput();
        var probe = new byte[1];
        while (await input.ReadAsync(probe) > 0) { }
    }
    catch { }
    shutdown.Cancel();
});

string? ValueAfter(string option)
{
    var index = Array.FindIndex(args, value => value.Equals(option, StringComparison.OrdinalIgnoreCase));
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

var pidText = ValueAfter("--pid");
if (uint.TryParse(pidText, out var processId) && processId > 0)
{
    // Захват процесса идёт до микшера Windows, поэтому приложение можно
    // приглушить локально — в эфир звук продолжит уходить полным.
    // Полное приглушение глушит и захват (он идёт уже после регулятора
    // громкости Windows), поэтому громкость только понижается, а в эфире
    // потеря компенсируется усилением.
    var localLevel = double.TryParse(ValueAfter("--local-volume"), System.Globalization.NumberStyles.Float,
        System.Globalization.CultureInfo.InvariantCulture, out var parsed) ? Math.Clamp(parsed, 0.02, 1.0) : 1.0;
    // Уровень 1.0 тоже применяем: Windows запоминает громкость приложения
    // между запусками, и без этого однажды приглушённое так и осталось бы тихим.
    using var localMute = args.Contains("--local-volume", StringComparer.OrdinalIgnoreCase)
        ? new SessionMuter(processId, (float)localLevel) : null;
    ProcessLoopback.Gain = (float)(1.0 / localLevel);
    try { await ProcessLoopback.RunAsync(processId, Console.OpenStandardOutput(), shutdown.Token); }
    catch (Exception error) { Console.Error.WriteLine($"Process loopback failed: {error.Message}"); Environment.Exit(1); }
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

    // Компенсация локального приглушения: во float, без потери разрядности.
    internal static float Gain = 1f;

    private static async Task CaptureAsync(IAudioClient client, Stream output, CancellationToken token)
    {
        // Забираем звук в 32-битном float. Если приложение приглушено, тихий
        // сигнал приходится усиливать, и в 16 битах вылезал бы шум квантования
        // — в VRChat это слышно как шипение. Во float усиление чистое, а в
        // 16 бит сигнал переводится уже ПОСЛЕ усиления, на полной громкости.
        var format = new WaveFormatEx { FormatTag = 3, Channels = 2, SamplesPerSec = 48000, AvgBytesPerSec = 384000, BlockAlign = 8, BitsPerSample = 32, ExtraSize = 0 };
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
                        var floatBytes = checked((int)frames * 8);
                        var samples = new float[frames * 2];
                        if ((flags & 2) == 0 && data != IntPtr.Zero) Marshal.Copy(data, samples, 0, samples.Length);
                        Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames));
                        var packet = new byte[frames * 4];
                        for (var index = 0; index < samples.Length; index++)
                        {
                            var value = samples[index] * Gain;
                            if (value > 1f) value = 1f; else if (value < -1f) value = -1f;
                            var pcm = (short)(value * 32767f);
                            packet[index * 2] = (byte)(pcm & 0xFF);
                            packet[index * 2 + 1] = (byte)((pcm >> 8) & 0xFF);
                        }
                        ring.Write(packet);
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

// Глушит звук выбранного приложения только на этом компьютере: в эфир он идёт
// как был. Нужно, чтобы в наушниках не двоился звук — свой напрямую и он же
// с задержкой из VRChat. Сессии перепроверяются: приложение может создать
// новые (браузеры и плееры часто выводят звук из дочерних процессов).
internal sealed class SessionMuter : IDisposable
{
    private readonly uint _processId;
    private readonly string _processName;
    private readonly float _level;
    private readonly List<(SimpleAudioVolume Volume, float Original)> _muted = new();
    private readonly Timer _watch;
    private readonly MMDeviceEnumerator _enumerator = new();

    internal SessionMuter(uint processId, float level)
    {
        _processId = processId;
        _level = level;
        try { _processName = System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; }
        catch { _processName = string.Empty; }
        Apply();
        _watch = new Timer(_ => Apply(), null, 1000, 1000);
    }

    private void Apply()
    {
        try
        {
            using var device = _enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var sessions = device.AudioSessionManager.Sessions;
            for (var index = 0; index < sessions.Count; index++)
            {
                var session = sessions[index];
                if (!Matches(session)) continue;
                var volume = session.SimpleAudioVolume;
                // Мьют снимаем всегда: он глушит и захват тоже, а тихо у себя
                // мы делаем именно уровнем громкости.
                if (volume.Mute) volume.Mute = false;
                if (Math.Abs(volume.Volume - _level) < 0.001f) continue;
                lock (_muted) _muted.Add((volume, volume.Volume));
                volume.Volume = _level;
            }
        }
        catch { }
    }

    private bool Matches(AudioSessionControl session)
    {
        try
        {
            if (session.GetProcessID == _processId) return true;
            if (string.IsNullOrEmpty(_processName)) return false;
            // Дочерние процессы того же приложения носят то же имя
            return System.Diagnostics.Process.GetProcessById((int)session.GetProcessID).ProcessName == _processName;
        }
        catch { return false; }
    }

    public void Dispose()
    {
        _watch.Dispose();
        lock (_muted)
        {
            foreach (var (volume, original) in _muted)
            {
                try { volume.Volume = original; } catch { }
            }
            _muted.Clear();
        }
        _enumerator.Dispose();
    }
}

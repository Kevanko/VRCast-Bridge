using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace VRCastBridge.Launcher;

internal static class Program
{
    internal const string AppUrl = "http://127.0.0.1:4717/";
    private const string AppVersion = "0.40.2";

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var noWindow = args.Any(arg => arg.Equals("--no-browser", StringComparison.OrdinalIgnoreCase));
        // Пока программа не установлена, файл работает установщиком: спрашивает
        // папку и ярлык, ставит себя туда и запускает уже оттуда.
        if (!noWindow && !IsInstalled() && !args.Any(arg => arg.Equals("--run", StringComparison.OrdinalIgnoreCase)))
        {
            Application.Run(new SetupWindow());
            return;
        }
        // Если уже запущена ДРУГАЯ версия, новый запуск её закрывает и продолжает:
        // иначе после обновления снова открывалось старое окно, и выглядело это
        // так, будто обновление не сработало.
        var singleInstance = new Mutex(true, "Local\\VRCastBridge.Desktop", out var firstInstance);
        if (!firstInstance && !noWindow)
        {
            var runningVersion = GetServerVersion().GetAwaiter().GetResult();
            if (runningVersion is not null && runningVersion != AppVersion)
            {
                // Идущий эфир не рвём без спроса: человек может вещать прямо сейчас.
                if (IsBroadcasting().GetAwaiter().GetResult()
                    && MessageBox.Show(
                        $"Открыта версия {runningVersion}, и в ней идёт эфир.\nЗакрыть её и запустить {AppVersion}?",
                        "VRCast Bridge", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                {
                    singleInstance.Dispose();
                    return;
                }
                ShutdownServer();
                for (var attempt = 0; attempt < 60 && GetServerVersion().GetAwaiter().GetResult() is not null; attempt++)
                    Thread.Sleep(200);
                singleInstance.Dispose();
                singleInstance = new Mutex(true, "Local\\VRCastBridge.Desktop", out firstInstance);
            }
            if (!firstInstance)
            {
                FocusRunningWindow();
                singleInstance.Dispose();
                return;
            }
        }
        using var instanceLock = singleInstance;
        string runtimeDirectory;
        try { runtimeDirectory = EnsurePayload(); }
        catch (Exception error)
        {
            ShowError($"Не удалось распаковать компоненты приложения:\n{error.Message}");
            return;
        }
        CleanupOrphanHelpers();
        // Первый запуск ставит Node и кодировщик — это минуты. Без окна выглядит
        // так, будто программа не открылась вовсе, поэтому показываем ход дела.
        using var boot = noWindow ? null : new BootWindow();
        boot?.Show();
        Application.DoEvents();
        var подготовка = Task.Run(() => EnsureServer(runtimeDirectory));
        while (!подготовка.IsCompleted)
        {
            Application.DoEvents();
            Thread.Sleep(40);
        }
        var server = подготовка.GetAwaiter().GetResult();
        boot?.Hide();
        if (server is null && !IsReady().GetAwaiter().GetResult()) return;
        if (noWindow) return;
        using var processJob = server is null ? null : ChildProcessJob.Attach(server);
        Application.Run(new MainWindow(server));
    }

    private static string EnsurePayload()
    {
        var runtimeDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "runtime", AppVersion);
        var resources = new Dictionary<string, string>
        {
            ["VRCast.Payload.server.js"] = Path.Combine("src", "server.js"),
            ["VRCast.Payload.index.html"] = Path.Combine("public", "index.html"),
            ["VRCast.Payload.styles.css"] = Path.Combine("public", "styles.css"),
            ["VRCast.Payload.app.js"] = Path.Combine("public", "app.js"),
            ["VRCast.Payload.hls.min.js"] = Path.Combine("public", "vendor", "hls.min.js"),
            ["VRCast.Payload.AudioCapture.exe"] = Path.Combine("tools", "VRCast.AudioCapture.exe"),
            ["VRCast.Payload.WindowCapture.exe"] = Path.Combine("tools", "VRCast.WindowCapture.exe"),
            ["VRCast.Payload.Plink.exe"] = Path.Combine("tools", "plink.exe"),
            ["VRCast.Payload.Cloudflared.exe"] = Path.Combine("tools", "cloudflared.exe"),
            ["VRCast.Payload.Pinggy.exe"] = Path.Combine("tools", "pinggy.exe"),
            ["VRCast.Payload.MediaMtx.exe"] = Path.Combine("tools", "mediamtx.exe"),
            ["VRCast.Payload.ytdlp.exe"] = Path.Combine("tools", "yt-dlp.exe"),
            ["VRCast.Payload.logo.png"] = Path.Combine("public", "logo.png"),
            ["VRCast.Payload.standby.png"] = Path.Combine("public", "standby.png")
        };

        var assembly = typeof(Program).Assembly;
        foreach (var resource in resources)
        {
            var destination = Path.Combine(runtimeDirectory, resource.Value);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            var input = assembly.GetManifestResourceStream(resource.Key);
            // Сторонние утилиты внутрь могут не попасть — они докачиваются.
            // Обязательны только файлы самой программы.
            if (input is null)
            {
                if (resource.Value.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                throw new InvalidOperationException($"Не найден встроенный компонент {resource.Key}");
            }
            using var payloadStream = input;
            using var memory = new MemoryStream();
            payloadStream.CopyTo(memory);
            var payload = memory.ToArray();
            if (File.Exists(destination) && File.ReadAllBytes(destination).AsSpan().SequenceEqual(payload)) continue;
            File.WriteAllBytes(destination, payload);
        }
        CleanOldRuntimes(runtimeDirectory);
        return runtimeDirectory;
    }

    // Каждая версия распаковывается в свою папку. Старые никто не удалял, и за
    // месяц их набралось на 3,8 ГБ — диск забивался, а с полным диском ffmpeg
    // не может писать сегменты, и эфир начинает подвисать на ровном месте.
    private static void CleanOldRuntimes(string current)
    {
        try
        {
            var root = Path.GetDirectoryName(current);
            if (root is null) return;
            foreach (var directory in Directory.GetDirectories(root))
            {
                if (string.Equals(directory, current, StringComparison.OrdinalIgnoreCase)) continue;
                try { Directory.Delete(directory, true); } catch { }
            }
        }
        catch { }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    private static void FocusRunningWindow()
    {
        try
        {
            var mine = Environment.ProcessId;
            foreach (var process in Process.GetProcessesByName("VRCast Bridge"))
            {
                if (process.Id == mine || process.MainWindowHandle == IntPtr.Zero) continue;
                ShowWindow(process.MainWindowHandle, 9); // SW_RESTORE
                SetForegroundWindow(process.MainWindowHandle);
                return;
            }
        }
        catch { }
    }

    internal const string InstalledMarker = "vrcast.installed";

    internal static bool IsInstalled()
    {
        var folder = Path.GetDirectoryName(Environment.ProcessPath ?? Application.ExecutablePath);
        return folder is not null && File.Exists(Path.Combine(folder, InstalledMarker));
    }

    internal static Action<string>? BootStatus;

    private static async Task<Process?> EnsureServer(string runtimeDirectory)
    {
        var existingVersion = await GetServerVersion();
        if (existingVersion is not null)
        {
            ShutdownServer();
            for (var attempt = 0; attempt < 30 && await GetServerVersion() is not null; attempt++)
                await Task.Delay(100);
            if (await GetServerVersion() is not null)
            {
                ShowError("Порт 4717 занят старой версией VRCast Bridge. Закройте её через Диспетчер задач и повторите запуск.");
                return null;
            }
        }

        var serverFile = Path.Combine(runtimeDirectory, "src", "server.js");
        if (!File.Exists(serverFile))
        {
            ShowError("Не найден файл src\\server.js. Положите VRCast Bridge.exe в корневую папку приложения.");
            return null;
        }

        var nodePath = FindNode();
        if (nodePath is null)
        {
            BootStatus?.Invoke("Устанавливаю Node.js…");
            nodePath = await DownloadNode();
            if (nodePath is null)
            {
                ShowError("Не удалось скачать Node.js. Проверьте интернет или установите Node.js 20 вручную.");
                return null;
            }
        }

        Process? server;
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = "\"src\\server.js\"",
                WorkingDirectory = runtimeDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            };
            // Путь к своему EXE нужен серверу, чтобы поставить обновление.
            startInfo.EnvironmentVariables["VRCAST_EXE"] = Environment.ProcessPath ?? Application.ExecutablePath;
            server = Process.Start(startInfo);
            // Вывод сервера пишем в файл: если он не поднимется, причина видна,
            // а не теряется вместе с невидимым окном консоли.
            if (server is not null)
            {
                var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "launcher.log");
                try { Directory.CreateDirectory(Path.GetDirectoryName(logPath)!); File.WriteAllText(logPath, string.Empty); } catch { }
                void Save(string? line)
                {
                    if (line is null) return;
                    try { File.AppendAllText(logPath, line + Environment.NewLine); } catch { }
                }
                server.OutputDataReceived += (_, args) => Save(args.Data);
                server.ErrorDataReceived += (_, args) => Save(args.Data);
                server.BeginOutputReadLine();
                server.BeginErrorReadLine();
            }
        }
        catch (Exception error)
        {
            ShowError($"Не удалось запустить сервер:\n{error.Message}");
            return null;
        }

        BootStatus?.Invoke("Запускаю сервер…");
        for (var attempt = 0; attempt < 900; attempt++)
        {
            if (await IsReady()) return server;
            if (server?.HasExited == true) break;
            await Task.Delay(120);
        }

        var tail = string.Empty;
        try
        {
            var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "launcher.log");
            if (File.Exists(logPath)) tail = string.Join(Environment.NewLine, File.ReadAllLines(logPath).TakeLast(6));
        }
        catch { }
        ShowError("Сервер не запустился." + (tail.Length > 0 ? Environment.NewLine + Environment.NewLine + tail : Environment.NewLine + Environment.NewLine + "Проверьте интернет: при первом запуске догружаются компоненты."));
        return null;
    }

    private static void CleanupOrphanHelpers()
    {
        foreach (var name in new[] { "VRCast.AudioCapture", "VRCast.WindowCapture", "mediamtx" })
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                try { process.Kill(true); process.WaitForExit(1500); }
                catch { }
                finally { process.Dispose(); }
            }
        }
    }

    // Node нужен для работы сервера. Если его нет в системе, скачиваем
    // официальную сборку в папку данных — ставить ничего не требуется.
    private static async Task<string?> DownloadNode()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "node");
        var ready = Path.Combine(root, "node.exe");
        if (File.Exists(ready)) return ready;
        try
        {
            Directory.CreateDirectory(root);
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            http.DefaultRequestHeaders.Add("User-Agent", "VRCast-Bridge");
            const string url = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip";
            var archive = Path.Combine(root, "node.zip");
            await using (var source = await http.GetStreamAsync(url))
            await using (var file = File.Create(archive))
                await source.CopyToAsync(file);

            var unpack = Path.Combine(root, "unpack");
            if (Directory.Exists(unpack)) Directory.Delete(unpack, true);
            Directory.CreateDirectory(unpack);
            // Системный tar распаковывает zip без сторонних библиотек.
            var tar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
            using (var unzip = Process.Start(new ProcessStartInfo
            {
                FileName = File.Exists(tar) ? tar : "tar",
                Arguments = $"-xf \"{archive}\" -C \"{unpack}\"",
                UseShellExecute = false,
                CreateNoWindow = true
            }))
            {
                if (unzip is null) return null;
                await unzip.WaitForExitAsync();
            }
            var found = Directory.GetFiles(unpack, "node.exe", SearchOption.AllDirectories).FirstOrDefault();
            if (found is null) return null;
            File.Copy(found, ready, true);
            File.Delete(archive);
            Directory.Delete(unpack, true);
            return ready;
        }
        catch { return null; }
    }

    private static string? FindNode()
    {
        var own = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "node", "node.exe");
        if (File.Exists(own)) return own;
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "where.exe",
                Arguments = "node.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            });
            var firstLine = process?.StandardOutput.ReadLine();
            process?.WaitForExit(3000);
            return !string.IsNullOrWhiteSpace(firstLine) && File.Exists(firstLine) ? firstLine : null;
        }
        catch { return null; }
    }

    private static async Task<string?> GetServerVersion()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(700) };
            using var response = await client.GetAsync($"{AppUrl}api/status");
            if (response.StatusCode != HttpStatusCode.OK) return null;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            return document.RootElement.TryGetProperty("appVersion", out var version) ? version.GetString() ?? "" : "";
        }
        catch { return null; }
    }

    // Идёт ли сейчас эфир в уже запущенной копии.
    internal static async Task<bool> IsBroadcasting()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            var text = await http.GetStringAsync($"{AppUrl}api/status");
            return text.Contains("\"running\":true", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    internal static async Task<bool> IsReady() => await GetServerVersion() == AppVersion;

    internal static void ShutdownServer()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            client.PostAsync($"{AppUrl}api/shutdown", content).GetAwaiter().GetResult();
        }
        catch { }
    }

    internal static void ShowError(string message) =>
        MessageBox.Show(message, "VRCast Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error);
}

internal sealed class ChildProcessJob : IDisposable
{
    private IntPtr _handle;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    private ChildProcessJob(Process process)
    {
        _handle = CreateJobObject(IntPtr.Zero, null);
        if (_handle == IntPtr.Zero) throw new InvalidOperationException("Windows не создала группу процессов.");
        var information = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = JobObjectLimitKillOnJobClose }
        };
        var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(_handle, 9, pointer, (uint)size) || !AssignProcessToJobObject(_handle, process.Handle))
                throw new InvalidOperationException("Windows не смогла привязать процессы трансляции к приложению.");
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    internal static ChildProcessJob Attach(Process process) => new(process);

    public void Dispose()
    {
        if (_handle == IntPtr.Zero) return;
        CloseHandle(_handle);
        _handle = IntPtr.Zero;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)] private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
}

// Установщик: куда положить программу и делать ли ярлык.
internal sealed class SetupWindow : Form
{
    private readonly TextBox _folder = new() { Left = 20, Top = 76, Width = 380, Height = 26 };
    private readonly Button _browse = new() { Left = 408, Top = 75, Width = 92, Height = 28, Text = "Обзор…" };
    private readonly CheckBox _desktop = new() { Left = 20, Top = 118, Width = 480, Text = "Создать ярлык на рабочем столе", Checked = true };
    private readonly CheckBox _menu = new() { Left = 20, Top = 144, Width = 480, Text = "Добавить в меню «Пуск»", Checked = true };
    private readonly Button _install = new() { Left = 380, Top = 216, Width = 120, Height = 34, Text = "Установить" };
    private readonly Label _status = new() { Left = 20, Top = 186, Width = 480, Height = 20, Text = "Программа займёт около 60 МБ." };
    private readonly ProgressBar _bar = new() { Left = 20, Top = 208, Width = 340, Height = 12, Visible = false };

    internal SetupWindow()
    {
        Text = "Установка VRCast Bridge";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(520, 270);
        BackColor = Color.FromArgb(13, 16, 23);
        ForeColor = Color.FromArgb(227, 230, 239);
        Font = new Font("Segoe UI", 9F);
        Icon = MainWindow.LoadAppIcon();

        Controls.Add(new Label { Left = 20, Top = 20, Width = 480, Height = 24, Font = new Font("Segoe UI", 12F, FontStyle.Bold), Text = "VRCast Bridge" });
        Controls.Add(new Label { Left = 20, Top = 50, Width = 480, Text = "Куда установить:" });
        _folder.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "VRCast Bridge");
        Controls.AddRange(new Control[] { _folder, _browse, _desktop, _menu, _status, _bar, _install });

        _browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { SelectedPath = _folder.Text };
            if (dialog.ShowDialog(this) == DialogResult.OK) _folder.Text = Path.Combine(dialog.SelectedPath, "VRCast Bridge");
        };
        AcceptButton = _install;
        _install.Click += async (_, _) => await InstallAsync();
    }

    private async Task InstallAsync()
    {
        _install.Enabled = false; _browse.Enabled = false; _folder.Enabled = false;
        _bar.Visible = true; _bar.Style = ProgressBarStyle.Marquee;
        _status.Text = "Копирую программу…";
        try
        {
            var target = _folder.Text.Trim();
            Directory.CreateDirectory(target);
            var source = Environment.ProcessPath ?? Application.ExecutablePath;
            var destination = Path.Combine(target, "VRCast Bridge.exe");
            if (!string.Equals(source, destination, StringComparison.OrdinalIgnoreCase))
                await Task.Run(() => File.Copy(source, destination, true));
            await File.WriteAllTextAsync(Path.Combine(target, Program.InstalledMarker), DateTime.Now.ToString("s"));

            if (_desktop.Checked) MakeShortcut(destination, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "VRCast Bridge.lnk"));
            if (_menu.Checked) MakeShortcut(destination, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "VRCast Bridge.lnk"));

            _status.Text = "Готово. Запускаю…";
            Process.Start(new ProcessStartInfo(destination) { WorkingDirectory = target, UseShellExecute = true });
            await Task.Delay(600);
            Close();
        }
        catch (Exception error)
        {
            _bar.Visible = false;
            _status.Text = $"Не удалось установить: {error.Message}";
            _install.Enabled = true; _browse.Enabled = true; _folder.Enabled = true;
        }
    }

    // Ярлык делаем через WScript.Shell: своих библиотек для этого не нужно.
    private static void MakeShortcut(string target, string linkPath)
    {
        try
        {
            var script = $"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{linkPath}');" +
                         $"$s.TargetPath='{target}';$s.WorkingDirectory='{Path.GetDirectoryName(target)}';$s.Save()";
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -NonInteractive -Command \"{script}\"",
                UseShellExecute = false,
                CreateNoWindow = true
            });
            process?.WaitForExit(15000);
        }
        catch { }
    }
}

// Маленькое окно на время подготовки: видно, что программа жива.
internal sealed class BootWindow : Form
{
    private readonly Label _text = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.FromArgb(227, 230, 239),
        Font = new Font("Segoe UI", 10F),
        Text = "VRCast Bridge готовится к работе…"
    };

    internal BootWindow()
    {
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(420, 130);
        BackColor = Color.FromArgb(13, 16, 23);
        Text = "VRCast Bridge";
        Icon = MainWindow.LoadAppIcon();
        Controls.Add(_text);
        Program.BootStatus = message => { try { BeginInvoke(() => { _text.Text = message; Application.DoEvents(); }); } catch { } };
    }
}

internal sealed class MainWindow : Form
{
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private bool _closing;

    // Без явной иконки WinForms подставляет свою стандартную заглушку — именно
    // она и висела на панели задач вместо логотипа приложения.
    internal static Icon? LoadAppIcon()
    {
        try
        {
            using var stream = typeof(Program).Assembly.GetManifestResourceStream("VRCast.Payload.icon.ico");
            return stream is null ? null : new Icon(stream);
        }
        catch { return null; }
    }

    internal MainWindow(Process? server)
    {
        Text = "VRCast Bridge";
        Icon = LoadAppIcon();
        Width = 1180;
        Height = 760;
        MinimumSize = new Size(980, 640);
        StartPosition = FormStartPosition.CenterScreen;

        BackColor = Color.FromArgb(10, 12, 11);
        AllowDrop = true;
        _webView.AllowExternalDrop = false;
        Controls.Add(_webView);
        Shown += InitializeWebView;
        // Свёрнутое окно не должно декодировать эфир: страница гасит предпросмотр.
        Resize += (_, _) =>
        {
            var name = WindowState == FormWindowState.Minimized ? "vrcast-hidden" : "vrcast-shown";
            try { _webView.CoreWebView2?.ExecuteScriptAsync($"document.dispatchEvent(new Event('{name}'))"); } catch { }
        };
        // Геометрию применяем после создания окна: до этого WinForms пересчитывает
        // координаты под DPI другого монитора и окно уползает при каждом запуске.
        Shown += (_, _) => RestoreGeometry();
        FormClosing += OnClosing;
        DragEnter += (_, args) => { if (args.Data?.GetDataPresent(DataFormats.FileDrop) == true) args.Effect = DragDropEffects.Copy; };
        DragDrop += async (_, args) =>
        {
            if (args.Data?.GetData(DataFormats.FileDrop) is string[] paths) await AddMediaFiles(paths);
        };
        _webView.DragEnter += (_, args) => { if (args.Data?.GetDataPresent(DataFormats.FileDrop) == true) args.Effect = DragDropEffects.Copy; };
        _webView.DragDrop += async (_, args) =>
        {
            if (args.Data?.GetData(DataFormats.FileDrop) is string[] paths) await AddMediaFiles(paths);
        };
    }

    // Окно программы рисует WebView2. Если рантайма нет, раньше показывалась
    // ошибка и программа закрывалась — теперь ставим его сами, как и остальные
    // зависимости.
    private static async Task<bool> EnsureWebView2()
    {
        try { CoreWebView2Environment.GetAvailableBrowserVersionString(); return true; }
        catch { }
        try
        {
            var setup = Path.Combine(Path.GetTempPath(), "MicrosoftEdgeWebview2Setup.exe");
            using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) })
            await using (var source = await http.GetStreamAsync("https://go.microsoft.com/fwlink/p/?LinkId=2124703"))
            await using (var file = File.Create(setup))
                await source.CopyToAsync(file);
            using var installer = Process.Start(new ProcessStartInfo
            {
                FileName = setup,
                Arguments = "/silent /install",
                UseShellExecute = false,
                CreateNoWindow = true
            });
            if (installer is not null) await installer.WaitForExitAsync();
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            return true;
        }
        catch { return false; }
    }

    private async void InitializeWebView(object? sender, EventArgs eventArgs)
    {
        try
        {
            if (!await EnsureWebView2())
            {
                Program.ShowError("Не удалось установить Microsoft Edge WebView2 Runtime.\nПроверьте интернет и запустите программу снова.");
                Close();
                return;
            }
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await _webView.EnsureCoreWebView2Async(environment);
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
            _webView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
                    Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            };
            _webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (args.Uri.StartsWith("vrcast://select-region", StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    BeginInvoke(SelectRegion);
                    return;
                }
                if (args.Uri.StartsWith("vrcast://pick-media", StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    BeginInvoke(PickMediaFiles);
                    return;
                }
                if (args.Uri.StartsWith("vrcast://highlight", StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    BeginInvoke(() => HighlightSource(args.Uri));
                    return;
                }
                if (args.Uri.StartsWith("vrcast://open-folder", StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge");
                    BeginInvoke(() =>
                    {
                        try { Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true }); } catch { }
                    });
                    return;
                }
                if (args.Uri.StartsWith("vrcast://close", StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    BeginInvoke(Close);
                }
            };
            // На первом запуске программа докачивает Node и кодировщик — это минуты.
            // Раньше окно сразу шло на адрес сервера и показывало «не удалось открыть
            // страницу». Теперь показываем заставку и повторяем, пока сервер не ответит.
            if (await Program.IsReady())
            {
                _webView.CoreWebView2.Navigate(Program.AppUrl);
            }
            else
            {
                ShowSplash();
                _ = WaitForServerAsync();
            }
        }
        catch (Exception error)
        {
            Program.ShowError($"Не удалось открыть окно программы:\n{error.Message}\n\nУбедитесь, что Microsoft Edge WebView2 Runtime установлен.");
            Close();
        }
    }

    // Ждём готовности сервера в фоне и открываем окно ровно один раз.
    private async Task WaitForServerAsync()
    {
        for (var attempt = 0; attempt < 600 && !_closing; attempt++)
        {
            if (await Program.IsReady())
            {
                if (!_closing) BeginInvoke(() => _webView.CoreWebView2?.Navigate(Program.AppUrl));
                return;
            }
            await Task.Delay(300);
        }
    }

    private void ShowSplash()
    {
        try
        {
            _webView.CoreWebView2?.NavigateToString(
                "<!doctype html><meta charset=\"utf-8\">" +
                "<style>html,body{height:100%;margin:0;display:grid;place-items:center;background:#0d1017;" +
                "color:#8a91a6;font:14px 'Segoe UI',system-ui,sans-serif}" +
                "div{display:grid;gap:10px;justify-items:center}" +
                "b{color:#e3e6ef;font-size:15px;font-weight:600}" +
                "i{width:26px;height:26px;border:2px solid #2a3145;border-top-color:#7a78cf;border-radius:50%;" +
                "animation:spin 1s linear infinite}" +
                "@keyframes spin{to{transform:rotate(360deg)}}</style>" +
                "<div><i></i><b>VRCast Bridge готовится к работе</b>" +
                "<span>Первый запуск: догружаются недостающие компоненты.</span></div>");
        }
        catch { }
    }

    private async void PickMediaFiles()
    {
        using var dialog = new OpenFileDialog
        {
            Multiselect = true,
            Title = "Добавить в медиа-очередь",
            Filter = "Видео и аудио|*.mp4;*.mkv;*.webm;*.mov;*.avi;*.m4v;*.mp3;*.m4a;*.aac;*.flac;*.wav;*.ogg;*.opus|Все файлы|*.*"
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) await AddMediaFiles(dialog.FileNames);
    }

    private async Task AddMediaFiles(string[] paths)
    {
        var json = JsonSerializer.Serialize(paths);
        await _webView.ExecuteScriptAsync($"window.addLocalFiles({json})");
    }

    private async void SelectRegion()
    {
        Hide();
        await Task.Delay(180);
        using var selector = new RegionSelector();
        var result = selector.ShowDialog();
        Show();
        Activate();
        if (result != DialogResult.OK || selector.SelectedRegion.Width < 64 || selector.SelectedRegion.Height < 64) return;
        var region = selector.SelectedRegion;
        await _webView.ExecuteScriptAsync($"window.applySelectedRegion({{x:{region.X},y:{region.Y},width:{region.Width},height:{region.Height}}})");
    }

    private void HighlightSource(string uriText)
    {
        try
        {
            var uri = new Uri(uriText);
            var values = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(part => part.Split('=', 2))
                .Where(part => part.Length == 2)
                .ToDictionary(part => part[0], part => int.Parse(Uri.UnescapeDataString(part[1])));
            var rectangle = new Rectangle(values["x"], values["y"], values["width"], values["height"]);
            if (rectangle.Width < 32 || rectangle.Height < 32) return;
            var outline = new CaptureOutline(rectangle);
            outline.Show();
        }
        catch { }
    }

    // Размер и положение окна помнятся между запусками.
    private static string GeometryPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCastBridge", "window.txt");

    private void RestoreGeometry()
    {
        try
        {
            var parts = File.ReadAllText(GeometryPath).Split(',');
            if (parts.Length != 5) return;
            var saved = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
            if (saved.Width < MinimumSize.Width || saved.Height < MinimumSize.Height) return;
            // Монитор могли отключить — окно не должно уехать за пределы рабочего стола.
            if (!Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(saved))) return;
            StartPosition = FormStartPosition.Manual;
            Bounds = saved;
            if (parts[4] == "1") WindowState = FormWindowState.Maximized;
        }
        catch { }
    }

    private void SaveGeometry()
    {
        try
        {
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var maximized = WindowState == FormWindowState.Maximized ? 1 : 0;
            Directory.CreateDirectory(Path.GetDirectoryName(GeometryPath)!);
            File.WriteAllText(GeometryPath, $"{bounds.X},{bounds.Y},{bounds.Width},{bounds.Height},{maximized}");
        }
        catch { }
    }

    private void OnClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (_closing) return;
        _closing = true;
        SaveGeometry();
        Program.ShutdownServer();
    }
}

internal sealed class RegionSelector : Form
{
    private Point _start;
    private Rectangle _selection;
    private bool _dragging;

    internal Rectangle SelectedRegion => new(_selection.X + Bounds.X, _selection.Y + Bounds.Y, _selection.Width, _selection.Height);

    internal RegionSelector()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = SystemInformation.VirtualScreen;
        TopMost = true;
        ShowInTaskbar = false;
        BackColor = Color.Black;
        Opacity = 0.35;
        Cursor = Cursors.Cross;
        DoubleBuffered = true;
        KeyPreview = true;
        MouseDown += (_, args) =>
        {
            if (args.Button != MouseButtons.Left) return;
            _start = args.Location;
            _selection = Rectangle.Empty;
            _dragging = true;
        };
        MouseMove += (_, args) =>
        {
            if (!_dragging) return;
            _selection = Normalize(_start, args.Location);
            Invalidate();
        };
        MouseUp += (_, args) =>
        {
            if (!_dragging || args.Button != MouseButtons.Left) return;
            _dragging = false;
            _selection = Normalize(_start, args.Location);
            DialogResult = _selection.Width >= 64 && _selection.Height >= 64 ? DialogResult.OK : DialogResult.Cancel;
            Close();
        };
        KeyDown += (_, args) =>
        {
            if (args.KeyCode != Keys.Escape) return;
            DialogResult = DialogResult.Cancel;
            Close();
        };
    }

    protected override void OnPaint(PaintEventArgs args)
    {
        base.OnPaint(args);
        if (_selection.IsEmpty) return;
        using var fill = new SolidBrush(Color.FromArgb(90, 169, 112, 255));
        using var pen = new Pen(Color.FromArgb(169, 112, 255), 4);
        args.Graphics.FillRectangle(fill, _selection);
        args.Graphics.DrawRectangle(pen, _selection);
    }

    private static Rectangle Normalize(Point start, Point end) => new(
        Math.Min(start.X, end.X), Math.Min(start.Y, end.Y),
        Math.Abs(end.X - start.X), Math.Abs(end.Y - start.Y));
}

internal sealed class CaptureOutline : Form
{
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 2200 };
    private static readonly IntPtr HwndTopMost = new(-1);
    private const uint WdaExcludeFromCapture = 0x00000011;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoSize = 0x0001;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    protected override bool ShowWithoutActivation => true;

    private readonly Rectangle _target;

    internal CaptureOutline(Rectangle rectangle)
    {
        // Рамку кладём ВНУТРЬ окна: снаружи её не видно у окна на весь экран.
        _target = rectangle;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = false;
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        DoubleBuffered = true;
        _timer.Tick += (_, _) => Close();
        Shown += (_, _) =>
        {
            SetWindowDisplayAffinity(Handle, WdaExcludeFromCapture);
            // Координаты ставим уже созданному окну: WinForms пересчитывает
            // Bounds под масштаб экрана, и рамка уезжала мимо цели.
            SetWindowPos(Handle, HwndTopMost, _target.X, _target.Y, _target.Width, _target.Height, SwpNoActivate);
            _timer.Start();
        };
        FormClosed += (_, _) => _timer.Dispose();
    }

    protected override void OnPaint(PaintEventArgs args)
    {
        base.OnPaint(args);
        // Толще и с тёмным контуром — видно и на светлом, и на тёмном кадре.
        using var shadow = new Pen(Color.FromArgb(190, 12, 14, 22), 8);
        using var edge = new Pen(Color.FromArgb(235, 122, 120, 207), 4);
        var outer = new Rectangle(4, 4, Math.Max(1, ClientSize.Width - 9), Math.Max(1, ClientSize.Height - 9));
        args.Graphics.DrawRectangle(shadow, outer);
        args.Graphics.DrawRectangle(edge, outer);
    }
}

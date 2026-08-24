using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace VRCastBridge.Launcher;

internal static class Program
{
    internal const string AppUrl = "http://127.0.0.1:4717/";
    private const string AppVersion = "0.30.2";

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var noWindow = args.Any(arg => arg.Equals("--no-browser", StringComparison.OrdinalIgnoreCase));
        using var singleInstance = new Mutex(true, "Local\\VRCastBridge.Desktop", out var firstInstance);
        if (!firstInstance && !noWindow)
        {
            ShowError("VRCast Bridge уже запущен. Закройте открытое окно перед повторным запуском.");
            return;
        }
        string runtimeDirectory;
        try { runtimeDirectory = EnsurePayload(); }
        catch (Exception error)
        {
            ShowError($"Не удалось распаковать компоненты приложения:\n{error.Message}");
            return;
        }
        CleanupOrphanHelpers();
        var server = EnsureServer(runtimeDirectory).GetAwaiter().GetResult();
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
            ["VRCast.Payload.Cloudflared.exe"] = Path.Combine("tools", "cloudflared.exe"),
            ["VRCast.Payload.Pinggy.exe"] = Path.Combine("tools", "pinggy.exe"),
            ["VRCast.Payload.MediaMtx.exe"] = Path.Combine("tools", "mediamtx.exe"),
            ["VRCast.Payload.Plink.exe"] = Path.Combine("tools", "plink.exe"),
            ["VRCast.Payload.logo.png"] = Path.Combine("public", "logo.png"),
            ["VRCast.Payload.standby.png"] = Path.Combine("public", "standby.png"),
            ["VRCast.Payload.ytdlp.exe"] = Path.Combine("tools", "yt-dlp.exe")
        };

        var assembly = typeof(Program).Assembly;
        foreach (var resource in resources)
        {
            var destination = Path.Combine(runtimeDirectory, resource.Value);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            using var input = assembly.GetManifestResourceStream(resource.Key)
                ?? throw new InvalidOperationException($"Не найден встроенный компонент {resource.Key}");
            using var memory = new MemoryStream();
            input.CopyTo(memory);
            var payload = memory.ToArray();
            if (File.Exists(destination) && File.ReadAllBytes(destination).AsSpan().SequenceEqual(payload)) continue;
            File.WriteAllBytes(destination, payload);
        }
        return runtimeDirectory;
    }

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
            ShowError("Не найден Node.js. Установите Node.js 20 или новее и запустите приложение снова.");
            return null;
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
                WindowStyle = ProcessWindowStyle.Hidden
            };
            // Путь к своему EXE нужен серверу, чтобы поставить обновление.
            startInfo.EnvironmentVariables["VRCAST_EXE"] = Environment.ProcessPath ?? Application.ExecutablePath;
            server = Process.Start(startInfo);
        }
        catch (Exception error)
        {
            ShowError($"Не удалось запустить сервер:\n{error.Message}");
            return null;
        }

        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (await IsReady()) return server;
            if (server?.HasExited == true) break;
            await Task.Delay(120);
        }

        ShowError("Сервер не запустился. Проверьте, что FFmpeg и yt-dlp доступны в PATH.");
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

    private static string? FindNode()
    {
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

    private async void InitializeWebView(object? sender, EventArgs eventArgs)
    {
        try
        {
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
                if (args.Uri.StartsWith("vrcast://close", StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    BeginInvoke(Close);
                }
            };
            _webView.Source = new Uri(Program.AppUrl);
        }
        catch (Exception error)
        {
            Program.ShowError($"Не удалось открыть окно программы:\n{error.Message}\n\nУбедитесь, что Microsoft Edge WebView2 Runtime установлен.");
            Close();
        }
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

    internal CaptureOutline(Rectangle rectangle)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        rectangle.Inflate(3, 3);
        Bounds = rectangle;
        TopMost = true;
        ShowInTaskbar = false;
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        DoubleBuffered = true;
        _timer.Tick += (_, _) => Close();
        Shown += (_, _) =>
        {
            SetWindowDisplayAffinity(Handle, WdaExcludeFromCapture);
            SetWindowPos(Handle, HwndTopMost, 0, 0, 0, 0, SwpNoActivate | SwpNoMove | SwpNoSize);
            _timer.Start();
        };
        FormClosed += (_, _) => _timer.Dispose();
    }

    protected override void OnPaint(PaintEventArgs args)
    {
        base.OnPaint(args);
        using var edge = new Pen(Color.FromArgb(210, 173, 124, 255), 2);
        var rectangle = new Rectangle(1, 1, Math.Max(1, ClientSize.Width - 3), Math.Max(1, ClientSize.Height - 3));
        args.Graphics.DrawRectangle(edge, rectangle);
    }
}

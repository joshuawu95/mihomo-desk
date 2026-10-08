using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static string DataDirectory;
    internal static string MixedPort;
    internal static string ControllerPort;

    static string Option(string[] args, string name, string fallback)
    {
        int index = Array.IndexOf(args, "--" + name);
        return index < 0 ? fallback : args[index + 1];
    }

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        DataDirectory = Path.GetFullPath(Option(args, "data-dir",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MihomoDesk")));
        MixedPort = Option(args, "mixed-port", "17890");
        ControllerPort = Option(args, "controller-port", "19090");
        Directory.CreateDirectory(DataDirectory);
        try
        {
            if (Array.IndexOf(args, "--proxy-on") >= 0) { SystemProxy.Enable(DataDirectory, MixedPort); return 0; }
            if (Array.IndexOf(args, "--proxy-off") >= 0) { SystemProxy.Restore(DataDirectory); return 0; }
            string hash;
            using (SHA256 sha = SHA256.Create())
                hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(DataDirectory.ToUpperInvariant()))).Replace("-", "");
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\MihomoDesk-" + hash, out created))
            {
                if (!created)
                {
                    for (int i = 0; i < 100; i++)
                    {
                        try
                        {
                            var instance = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(DataDirectory, "instance.json")));
                            int pid = Convert.ToInt32(instance["pid"]);
                            using (Process existing = Process.GetProcessById(pid))
                                if (existing.HasExited) throw new InvalidOperationException();
                            if (Array.IndexOf(args, "--no-open") < 0) OpenBrowser((string)instance["url"]);
                            return 0;
                        }
                        catch { Thread.Sleep(100); }
                    }
                    throw new InvalidOperationException("Another instance is starting or unresponsive. Check its tray icon and server.log.");
                }
                try { Application.Run(new TrayContext(Array.IndexOf(args, "--no-open") < 0)); }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            File.AppendAllText(Path.Combine(DataDirectory, "server.log"), error.ToString() + Environment.NewLine);
            if (Array.IndexOf(args, "--proxy-on") < 0 && Array.IndexOf(args, "--proxy-off") < 0)
                MessageBox.Show(error.Message, "Mihomo Desk", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    internal static string Quote(string value)
    {
        if (value.IndexOf('"') >= 0) throw new ArgumentException("Quotes are not allowed in paths");
        return "\"" + value.TrimEnd('\\') + "\"";
    }
    internal static void OpenBrowser(string url)
    {
        Uri uri = new Uri(url);
        if (uri.Scheme != "http" || uri.Host != "127.0.0.1") throw new InvalidOperationException("Invalid management URL");
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}

sealed class TrayContext : ApplicationContext
{
    readonly NotifyIcon tray;
    readonly Control dispatcher = new Control();
    readonly Process server;
    readonly Job job = new Job();
    readonly bool openAtStartup;
    string origin;
    string token;
    string url;
    bool quitting;

    public TrayContext(bool open)
    {
        openAtStartup = open;
        dispatcher.CreateControl();
        IntPtr unused = dispatcher.Handle;
        SystemProxy.Restore(Program.DataDirectory);
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Mihomo Desk", Visible = true };
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open management page", null, delegate { Open(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Start core", null, delegate { Command("/api/core/start", "{}"); });
        menu.Items.Add("Stop core", null, delegate { Command("/api/core/stop", "{}"); });
        menu.Items.Add("Restart core", null, delegate { Command("/api/core/restart", "{}"); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Enable system proxy", null, delegate { Command("/api/system-proxy", "{\"enabled\":true}"); });
        menu.Items.Add("Restore system proxy", null, delegate { Command("/api/system-proxy", "{\"enabled\":false}"); });
        menu.Items.Add("Open data folder", null, delegate { Process.Start(new ProcessStartInfo(Program.DataDirectory) { UseShellExecute = true }); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, delegate { Quit(); });
        tray.ContextMenuStrip = menu;
        tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Open(); };
        string root = AppDomain.CurrentDomain.BaseDirectory;
        server = new Process { StartInfo = new ProcessStartInfo {
            FileName = Path.Combine(root, "runtime", "node.exe"),
            Arguments = Program.Quote(Path.Combine(root, "server.mjs")) + " --data-dir " + Program.Quote(Program.DataDirectory)
                + " --mixed-port " + Program.MixedPort + " --controller-port " + Program.ControllerPort,
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        }, EnableRaisingEvents = true };
        server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (String.IsNullOrWhiteSpace(e.Data)) return;
            try
            {
                var ready = Program.Json.Deserialize<Dictionary<string, object>>(e.Data);
                if ((string)ready["event"] != "ready") return;
                dispatcher.BeginInvoke((Action)delegate {
                    origin = (string)ready["origin"]; token = (string)ready["token"]; url = (string)ready["url"];
                    if (openAtStartup) Open();
                    tray.ShowBalloonTip(3000, "Mihomo Desk", "Browser management is ready. Closing the browser keeps the proxy running.", ToolTipIcon.Info);
                });
            }
            catch (Exception error) { WriteLog(error.Message); }
        };
        server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) WriteLog(e.Data); };
        server.Exited += delegate
        {
            dispatcher.BeginInvoke((Action)delegate {
                if (!quitting && server.ExitCode != 0)
                    MessageBox.Show("The background service stopped. See server.log in " + Program.DataDirectory, "Mihomo Desk");
                ExitThread();
            });
        };
        if (!server.Start()) throw new InvalidOperationException("Cannot start the background service");
        try { job.Assign(server); }
        catch { server.Kill(); throw; }
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
    }
    void WriteLog(string message)
    {
        try { File.AppendAllText(Path.Combine(Program.DataDirectory, "server.log"), message + Environment.NewLine); }
        catch { }
    }
    void Open()
    {
        if (url != null) Program.OpenBrowser(url);
        else tray.ShowBalloonTip(2000, "Mihomo Desk", "The background service is starting.", ToolTipIcon.Info);
    }
    void Request(string route, string body)
    {
        if (origin == null) throw new InvalidOperationException("The background service is starting");
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + route);
        request.Proxy = null;
        request.Method = "POST";
        request.ContentType = "application/json";
        request.Headers["Authorization"] = "Bearer " + token;
        request.Timeout = 120000;
        byte[] data = Encoding.UTF8.GetBytes(body);
        request.ContentLength = data.Length;
        using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
        try { using (WebResponse response = request.GetResponse()) { } }
        catch (WebException error)
        {
            if (error.Response == null) throw;
            using (StreamReader reader = new StreamReader(error.Response.GetResponseStream()))
                throw new InvalidOperationException(reader.ReadToEnd());
        }
    }
    void Command(string route, string body)
    {
        ThreadPool.QueueUserWorkItem(delegate {
            try { Request(route, body); }
            catch (Exception error) { dispatcher.BeginInvoke((Action)delegate { tray.ShowBalloonTip(4000, "Mihomo Desk", error.Message, ToolTipIcon.Error); }); }
        });
    }
    void Quit()
    {
        if (quitting) return;
        quitting = true;
        ThreadPool.QueueUserWorkItem(delegate {
            try { Request("/api/quit", "{}"); }
            catch (Exception error) { WriteLog(error.Message); }
            if (!server.WaitForExit(120000))
            {
                WriteLog("Graceful shutdown timed out");
                dispatcher.BeginInvoke((Action)delegate { ExitThread(); });
            }
        });
    }
    protected override void ExitThreadCore()
    {
        job.Dispose();
        try { SystemProxy.Restore(Program.DataDirectory); }
        catch (Exception error) { WriteLog(error.Message); }
        tray.Visible = false;
        tray.Dispose();
        dispatcher.Dispose();
        server.Dispose();
        base.ExitThreadCore();
    }
}

static class SystemProxy
{
    const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    static readonly string[] Names = { "ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL" };
    [DllImport("wininet.dll", SetLastError = true)] static extern bool InternetSetOption(IntPtr internet, int option, IntPtr buffer, int length);
    static void Notify() { InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0); InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0); }
    public static void Enable(string directory, string port)
    {
        int numeric;
        if (!Int32.TryParse(port, out numeric) || numeric < 1024 || numeric > 65535) throw new ArgumentException("Invalid port");
        string file = Path.Combine(directory, "proxy-backup.json");
        if (File.Exists(file)) return;
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryPath, true))
        {
            var original = new Dictionary<string, object>();
            foreach (string name in Names)
            {
                object value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                original[name] = new Dictionary<string, object> { { "exists", value != null },
                    { "value", value }, { "kind", value == null ? "String" : key.GetValueKind(name).ToString() } };
            }
            string owned = "127.0.0.1:" + port;
            string content = Program.Json.Serialize(new Dictionary<string, object> { { "original", original }, { "owned", owned } });
            File.WriteAllText(file + ".tmp", content);
            File.Move(file + ".tmp", file);
            try
            {
                key.SetValue("ProxyServer", owned, RegistryValueKind.String);
                key.SetValue("ProxyOverride", "localhost;127.*;<local>", RegistryValueKind.String);
                key.SetValue("AutoConfigURL", "", RegistryValueKind.String);
                key.SetValue("ProxyEnable", 1, RegistryValueKind.DWord);
                Notify();
            }
            catch
            {
                RestoreValues(key, original);
                File.Delete(file);
                Notify();
                throw;
            }
        }
    }
    static void RestoreValues(RegistryKey key, Dictionary<string, object> original)
    {
        foreach (string name in Names)
        {
            var saved = (Dictionary<string, object>)original[name];
            if (!(bool)saved["exists"]) key.DeleteValue(name, false);
            else
            {
                RegistryValueKind kind = (RegistryValueKind)Enum.Parse(typeof(RegistryValueKind), (string)saved["kind"]);
                object value = saved["value"];
                if (kind == RegistryValueKind.DWord) value = Convert.ToInt32(value);
                key.SetValue(name, value, kind);
            }
        }
    }
    public static void Restore(string directory)
    {
        string file = Path.Combine(directory, "proxy-backup.json");
        if (!File.Exists(file)) return;
        var saved = Program.Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryPath, true))
        {
            // Another proxy client owns later edits; do not overwrite its settings.
            if (Convert.ToString(key.GetValue("ProxyServer")) == (string)saved["owned"] &&
                Convert.ToInt32(key.GetValue("ProxyEnable", 0)) == 1 &&
                Convert.ToString(key.GetValue("AutoConfigURL", "")) == "" &&
                Convert.ToString(key.GetValue("ProxyOverride", "")) == "localhost;127.*;<local>")
                RestoreValues(key, (Dictionary<string, object>)saved["original"]);
        }
        File.Delete(file);
        Notify();
    }
}

sealed class Job : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr handle;
    public Job()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        ExtendedLimits limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000;
        int size = Marshal.SizeOf(limits);
        IntPtr info = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, info, false);
            if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, info, (uint)size))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(info); }
    }
    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}

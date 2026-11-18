# Loaded once into a long-running PowerShell process. Each function prints one JSON line.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class VC {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = 1 }; i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags }; return i;
  }
  static void Send(List<INPUT> l) { if (l.Count > 0) SendInput((uint)l.Count, l.ToArray(), Marshal.SizeOf(typeof(INPUT))); }

  public static void TypeText(string text) {
    foreach (char c in text) {
      var l = new List<INPUT>();
      if (c == '\n') { l.Add(Key(0x0D, 0, 0)); l.Add(Key(0x0D, 0, 2)); }
      else { l.Add(Key(0, c, 4)); l.Add(Key(0, c, 4 | 2)); }
      Send(l);
      System.Threading.Thread.Sleep(4);
    }
  }

  static bool IsExtended(ushort vk) {
    return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x5D;
  }
  public static void Chord(ushort[] vks) {
    var l = new List<INPUT>();
    foreach (var v in vks) l.Add(Key(v, 0, IsExtended(v) ? 1u : 0u));
    for (int i = vks.Length - 1; i >= 0; i--) l.Add(Key(vks[i], 0, (IsExtended(vks[i]) ? 1u : 0u) | 2));
    Send(l);
  }

  public static void MouseButton(int x, int y, string button, int clicks) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(30);
    uint down = 2, up = 4;
    if (button == "right") { down = 8; up = 16; } else if (button == "middle") { down = 32; up = 64; }
    for (int c = 0; c < clicks; c++) {
      var l = new List<INPUT>();
      var d = new INPUT { type = 0 }; d.u.mi = new MOUSEINPUT { dwFlags = down }; l.Add(d);
      var u = new INPUT { type = 0 }; u.u.mi = new MOUSEINPUT { dwFlags = up }; l.Add(u);
      Send(l);
      System.Threading.Thread.Sleep(60);
    }
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Scroll(int x, int y, int amount) {
    SetCursorPos(x, y);
    var i = new INPUT { type = 0 }; i.u.mi = new MOUSEINPUT { dwFlags = 0x0800, mouseData = (uint)(amount * 120) };
    Send(new List<INPUT> { i });
  }

  public class Win { public long handle; public string title; public uint pid; public bool active; }
  public static List<Win> Windows() {
    var res = new List<Win>();
    var fg = GetForegroundWindow();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h); if (len == 0) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;            // owned popups
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;        // tool windows
      var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(new Win { handle = h.ToInt64(), title = sb.ToString(), pid = pid, active = h == fg });
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static bool Focus(long handle) {
    var h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 9);
    // Tapping Alt lets a background process take focus.
    Chord(new ushort[] { 0x12 });
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(150);
    return GetForegroundWindow() == h;
  }
  public static void Close(long handle) { PostMessage(new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  public static void Minimize(long handle) { ShowWindow(new IntPtr(handle), 6); }
  public static void Maximize(long handle) { ShowWindow(new IntPtr(handle), 3); }
}
'@
[void][VC]::SetProcessDPIAware()

function Out-Json($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) }

function VC-Screen {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  Out-Json @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
}

function VC-Screenshot([string]$path, [double]$scale) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
  $small = New-Object System.Drawing.Bitmap $bmp, $w, $h
  $small.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $small.Dispose()
  Out-Json @{ path = $path; width = $w; height = $h; originX = $b.X; originY = $b.Y }
}

function VC-Windows {
  $procs = @{}
  Get-Process | ForEach-Object { $procs[[uint32]$_.Id] = $_.ProcessName }
  $list = [VC]::Windows() | ForEach-Object {
    @{ handle = $_.handle; title = $_.title; process = $procs[$_.pid]; active = $_.active }
  }
  Out-Json @($list)
}

function VC-FocusedIsPassword {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    Out-Json @{ password = [bool]$el.Current.IsPassword; name = $el.Current.Name }
  } catch { Out-Json @{ password = $false; name = '' } }
}

# Lists interactive elements of the foreground window (buttons, fields, links, tabs, menu items...).
function VC-ReadUi([int]$max) {
  $hwnd = [VC]::Foreground()
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
  $CT = [System.Windows.Automation.ControlType]
  $wanted = @($CT::Button, $CT::Edit, $CT::Hyperlink, $CT::TabItem, $CT::MenuItem, $CT::ListItem,
              $CT::CheckBox, $CT::RadioButton, $CT::ComboBox, $CT::TreeItem, $CT::Document, $CT::SplitButton)
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    if ($out.Count -ge $max) { break }
    try {
      $c = $e.Current
      if ($wanted -notcontains $c.ControlType) { continue }
      if ($c.IsOffscreen) { continue }
      $r = $c.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { continue }
      $name = $c.Name
      if (-not $name) { $name = $c.HelpText }
      if (-not $name -and $c.ControlType -ne $CT::Edit) { continue }
      [void]$out.Add(@{ name = $name; type = $c.ControlType.ProgrammaticName.Replace('ControlType.', '');
        x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); enabled = $c.IsEnabled })
    } catch {}
  }
  $title = $root.Current.Name
  Out-Json @{ window = $title; elements = @($out) }
}

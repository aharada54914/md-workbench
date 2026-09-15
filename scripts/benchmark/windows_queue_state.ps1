param(
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OwnedProcessId,
  [Parameter(Mandatory=$true)][ValidatePattern('^MDW-QUEUE-[0-9]+-(main|window-[1-9][0-9]*)$')][string]$ExactTitle
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable GitHub-hosted Windows only' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class QueueWindowState {
  delegate bool EnumCallback(IntPtr window, IntPtr argument);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumCallback callback, IntPtr argument);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  static uint Owner(IntPtr window) { uint owner; GetWindowThreadProcessId(window, out owner); return owner; }
  static string Title(IntPtr window) { var text = new StringBuilder(256); GetWindowText(window, text, text.Capacity); return text.ToString(); }
  public static IntPtr Minimize(uint process, string title) {
    var matches = new List<IntPtr>();
    if (!EnumWindows((window, argument) => {
      if (Owner(window) == process && Title(window) == title) matches.Add(window);
      return true;
    }, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    if (matches.Count != 1) throw new InvalidOperationException("Expected one exact owned HWND; found " + matches.Count);
    IntPtr target = matches[0];
    if (!IsWindow(target) || Owner(target) != process || Title(target) != title)
      throw new InvalidOperationException("Owned window changed before setup");
    // SW_MINIMIZE. Its return value is previous visibility, not operation success.
    ShowWindow(target, 6);
    if (!IsWindow(target) || Owner(target) != process || Title(target) != title || !IsIconic(target))
      throw new InvalidOperationException("Owned window minimization was not observed");
    return target;
  }
}
'@
$target = [QueueWindowState]::Minimize([uint32]$OwnedProcessId, $ExactTitle)
[ordered]@{ pid = $OwnedProcessId; hwnd = $target.ToInt64().ToString(); title = $ExactTitle; minimized = [QueueWindowState]::IsIconic($target) } | ConvertTo-Json -Compress

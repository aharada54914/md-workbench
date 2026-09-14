param([Parameter(Mandatory=$true)][string]$Binary, [Parameter(Mandatory=$true)][string]$Output, [switch]$VerifyEditor)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable GitHub-hosted Windows only' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedWindowInput {
  delegate bool EnumCallback(IntPtr window, IntPtr argument);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr argument);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  public static string Title(IntPtr window) { var text=new StringBuilder(1024); GetWindowText(window,text,text.Capacity); return text.ToString(); }
  public static IntPtr DocumentWindow(uint process) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window, argument) => { uint owner; GetWindowThreadProcessId(window,out owner); string title=Title(window);
      if(owner==process && IsWindowVisible(window) && title.Length>0 && !title.EndsWith("-siw",StringComparison.OrdinalIgnoreCase)) { found=window; return false; } return true;
    },IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct Input { [FieldOffset(0)] public uint type; [FieldOffset(8)] public Keyboard key; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] events, int size);
  static Input Event(ushort vk, ushort scan, uint flags) { return new Input { type=1, key=new Keyboard { vk=vk, scan=scan, flags=flags } }; }
  public static void Control(ushort key) { Send(new [] { Event(17,0,0), Event(key,0,0), Event(key,0,2), Event(17,0,2) }); }
  public static void Text(string text) { foreach (char ch in text) Send(new [] { Event(0,ch,4), Event(0,ch,6) }); }
  static void Send(Input[] events) { if(SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(Input))) != events.Length) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
}
'@
$binaryPath = (Resolve-Path $Binary).Path
if (Test-Path $Output) { throw 'Output must be a fresh diagnostic directory' }
$out = (New-Item -ItemType Directory $Output).FullName
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$jp = -join ((0x65E5,0x672C,0x8A9E) | ForEach-Object { [char]$_ })
$suffix = ' Added-' + $jp + [char]::ConvertFromUtf32(0x1F600)
$results = @()

function Find-Name($root, [string]$name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Wait-Name($root, [string]$name) {
  $until = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $element = Find-Name $root $name
    if ($element -and -not $element.Current.IsOffscreen) { return $element }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $until)
  throw "No visible native UI element: $name"
}
function Assert-Foreground([IntPtr]$handle) {
  [void][OwnedWindowInput]::ShowWindow($handle, 9)
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.AppActivate([int]$child.Id)
  [void][OwnedWindowInput]::SetForegroundWindow($handle)
  $until = [DateTime]::UtcNow.AddSeconds(5)
  while ([OwnedWindowInput]::GetForegroundWindow() -ne $handle -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 100 }
  if ([OwnedWindowInput]::GetForegroundWindow() -ne $handle) { throw "Owned test window did not receive foreground; refusing keyboard input (target=$handle foreground=$([OwnedWindowInput]::GetForegroundWindow()) title=$($child.MainWindowTitle))" }
}
function Invoke-Button($root, [string]$name) {
  $button = Wait-Name $root $name
  $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
}

foreach ($format in @('lf','crlf','bom-crlf')) {
  $child = $null
  $result = @{ format=$format; status='running' }
  try {
    $newline = if ($format -eq 'lf') { "`n" } else { "`r`n" }
    $bom = if ($format -eq 'bom-crlf') { [string][char]0xFEFF } else { '' }
    $marker = 'MDW-UI-' + $format + '-' + $jp
    $source = $bom + (@(('# '+$marker), '', ':::unknown untouched', '', '$$a+b$$  ', '', 'MDW-END', '', '') -join $newline)
    $original = Join-Path $out ('original-'+$format+'.md')
    $document = Join-Path $out ('edit-'+$format+'.md')
    $bytes = $utf8.GetBytes($source)
    [IO.File]::WriteAllBytes($original, $bytes)
    [IO.File]::WriteAllBytes($document, $bytes)
    $originalHash = (Get-FileHash $original -Algorithm SHA256).Hash
    $child = Start-Process $binaryPath -ArgumentList @('"'+$document+'"') -PassThru
    $until = [DateTime]::UtcNow.AddSeconds(20)
    do { $child.Refresh(); if ($child.HasExited) { throw "App exited: $($child.ExitCode)" }; $handle=[OwnedWindowInput]::DocumentWindow([uint32]$child.Id); if ($handle -ne [IntPtr]::Zero) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $until)
    if ($handle -eq [IntPtr]::Zero) { throw 'No visible native document window (hidden single-instance window excluded)' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    Write-Output "Owned app pid=$($child.Id) title=$([OwnedWindowInput]::Title($handle)) handle=$handle"
    $heading = Wait-Name $root $marker
    [void](Wait-Name $root 'MDW-END')
    Assert-Foreground $handle
    $box = $heading.Current.BoundingRectangle
    if ($box.Width -lt 2 -or $box.Height -lt 2) { throw 'Empty heading geometry' }
    $bitmap = New-Object Drawing.Bitmap([int][Math]::Ceiling($box.Width), [int][Math]::Ceiling($box.Height))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen([int]$box.X, [int]$box.Y, 0, 0, $bitmap.Size)
      $minimum = 255; $maximum = 0
      for ($x=0; $x -lt $bitmap.Width; $x+=2) { for ($y=0; $y -lt $bitmap.Height; $y+=2) { $pixel=$bitmap.GetPixel($x,$y); $v=([int]$pixel.R+[int]$pixel.G+[int]$pixel.B)/3; $minimum=[Math]::Min($minimum,$v); $maximum=[Math]::Max($maximum,$v) } }
      if ($maximum-$minimum -lt 20) { throw 'Native heading screenshot is blank' }
      $bitmap.Save((Join-Path $out ($format+'-heading.png')), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    if ((Get-FileHash $document -Algorithm SHA256).Hash -ne $originalHash) { throw 'Viewing changed source bytes' }
    $result.render = 'native UIA heading/end text plus nonblank OS heading capture; not glyph or IME acceptance'
    if ($VerifyEditor) {
      Invoke-Button $root 'Isolated read-only preview'
      [void](Wait-Name $root $marker)
      Invoke-Button $root 'Return to editor'
      Invoke-Button $root 'Code'
      $editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $until = [DateTime]::UtcNow.AddSeconds(10)
      $editor = $null
      do { $edits=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$editCondition); foreach ($candidate in $edits) { if (-not $candidate.Current.IsOffscreen -and $candidate.Current.BoundingRectangle.Width -gt 250) { $editor=$candidate; break } }; if (-not $editor) { Start-Sleep -Milliseconds 100 } } while (-not $editor -and [DateTime]::UtcNow -lt $until)
      if (-not $editor) { throw 'No visible native CodeMirror textbox' }
      Assert-Foreground $handle
      $editor.SetFocus()
      [OwnedWindowInput]::Control(35)
      [OwnedWindowInput]::Text($suffix)
      [OwnedWindowInput]::Control(83)
      $expected = [Convert]::ToBase64String($utf8.GetBytes($source+$suffix))
      $until = [DateTime]::UtcNow.AddSeconds(10)
      do { $actual=[Convert]::ToBase64String([IO.File]::ReadAllBytes($document)); if ($actual -eq $expected) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $until)
      if ($actual -ne $expected) { throw 'Native Source save did not preserve exact source bytes and suffix' }
      $result.source_save_sha256 = (Get-FileHash $document -Algorithm SHA256).Hash
    }
    if ((Get-FileHash $original -Algorithm SHA256).Hash -ne $originalHash) { throw 'Original fixture was changed' }
    $result.status = 'passed'
  } catch { $result.status='failed'; $result.error=$_.Exception.Message; throw }
  finally {
    if ($child) { $child.Refresh(); if (-not $child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Host; if ($LASTEXITCODE -ne 0) { $result.status='failed'; $result.cleanup_error='Owned process tree did not terminate' } } }
    $results += $result
    $report = @{ os=[Environment]::OSVersion.VersionString; runner_arch=$env:RUNNER_ARCH; binary_sha256=(Get-FileHash $binaryPath -Algorithm SHA256).Hash; method='Windows UI Automation and normal keyboard input; no CDP or permission/policy changes'; results=$results }
    $json = $report | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText((Join-Path $out 'ui-results.json'), $json, $utf8)
    Write-Output $json
  }
  if ($result.status -ne 'passed') { throw 'Owned process cleanup failed; next cold launch refused' }
}
if ($results.status -contains 'failed') { exit 1 }

# DSH Studio Tools - single UI launcher (menu only, actions open consoles).
# ASCII-only labels to avoid console codepage issues.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $root "package.json"))) { $root = Split-Path -Parent $root }

function Get-CurrentVersion {
  try {
    $pkg = Get-Content (Join-Path $root "package.json") -Raw -ErrorAction Stop | ConvertFrom-Json
    return "version " + $pkg.version
  } catch { return "" }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "DSH Studio Tools"
$form.Size = New-Object System.Drawing.Size(460, 380)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = "Repo: $root`n$((Get-CurrentVersion))`nClick an action below (GitHub login may pop on first push)."
$label.Location = New-Object System.Drawing.Point(16, 12)
$label.Size = New-Object System.Drawing.Size(420, 50)

function New-Button($text, $x, $y, $action) {
  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = $text
  $btn.Location = New-Object System.Drawing.Point($x, $y)
  $btn.Size = New-Object System.Drawing.Size(200, 48)
  $btn.Add_Click($action)
  return $btn
}

# 1) Commit & push code (daily upload)
$pushBtn = New-Button "1) Commit & Push code", 16, 70, {
  Start-Process "cmd.exe" -ArgumentList "/k", "node `"scripts\push-code.mjs`"" -WorkingDirectory $root
}
# 2) One-click release
$releaseBtn = New-Button "2) One-click Release", 226, 70, {
  Start-Process "cmd.exe" -ArgumentList "/k", "node `"scripts\do-release.mjs`"" -WorkingDirectory $root
}
# 3) Open Actions page
$actionsBtn = New-Button "3) Open Actions (GitHub)", 16, 128, {
  Start-Process "https://github.com/well74741/dsh-desktop/actions"
}
# 4) Open project folder
$folderBtn = New-Button "4) Open project folder", 226, 128, {
  Start-Process "explorer.exe" $root
}
# 5) Quit
$quitBtn = New-Button "5) Exit", 16, 186, { $form.Close() }

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "Tips:`n  1 = daily code upload (asks a commit message).`n  2 = bump+tag+push, Actions builds the installer.`n  Retries 3x on network errors.`n  Manual download fallback in app tray menu."
$hint.Location = New-Object System.Drawing.Point(16, 250)
$hint.Size = New-Object System.Drawing.Size(420, 80)

$form.Controls.AddRange(@($label, $pushBtn, $releaseBtn, $actionsBtn, $folderBtn, $quitBtn, $hint))
[void]$form.ShowDialog()

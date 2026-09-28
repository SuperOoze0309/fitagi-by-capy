# Browser smoke test for the app's happy path.
#
#   npm run test:browser
#
# Starts a throwaway Vite dev server, drives headless Chrome through the app with
# `?smoke=1` (see src/dev/browserSmoke.ts) and fails if any check does not pass.
#
# The in-page run records a workout, reloads the page, verifies the data survived,
# walks the exercise-history, alias-rules, backup, meal, language and theme pages,
# and asserts that React logged no console errors.
#
# It runs TWICE, at a phone viewport and at a desktop one, because the layout
# switches between a bottom bar and a side rail at 56rem and both branches have to
# be exercised. Each run gets its own browser profile, so its IndexedDB starts empty
# and the two runs cannot influence each other.
#
# NOTE: this file is intentionally ASCII-only and is saved with a UTF-8 BOM, because
# Windows PowerShell 5.1 decodes BOM-less scripts as ANSI and would corrupt any
# non-ASCII character (which then breaks JSON parsing further down).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$chromeCandidates = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Host 'No Chrome/Edge binary found; skipping browser smoke test.'
  exit 0
}

$port = 5199
$baseDebugPort = 9333
$viteLog = Join-Path $env:TEMP 'fa-smoke-vite.log'

# name, width, height. 390x844 is a typical phone; 1280x900 is past the 56rem
# breakpoint where the side rail replaces the bottom bar.
$viewports = @(
  @{ Name = 'phone'; Width = 390; Height = 844 },
  @{ Name = 'desktop'; Width = 1280; Height = 900 }
)

$vite = $null
$chromeProc = $null

try {
  Write-Host "Starting dev server on port $port ..."
  $vite = Start-Process -FilePath 'npx.cmd' `
    -ArgumentList @('vite', '--port', "$port", '--strictPort') `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $viteLog -RedirectStandardError "$viteLog.err"

  $ready = $false
  foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      # not up yet
    }
  }
  if (-not $ready) { throw "dev server did not start; see $viteLog" }

  # Warm Vite's transform cache.
  #
  # The smoke module pulls in repositories, storage, the domain layer and the host
  # of the app. Vite transforms all of that on first request, which can take longer
  # than the harness is willing to wait, making the dynamic import look like a hang.
  # Requesting the entry module here forces the transform to happen up front.
  Write-Host 'Warming up the module graph ...'
  $warmTargets = @(
    '/src/dev/smokeEntry.ts',
    '/src/dev/browserSmoke.ts',
    '/src/dev/consoleErrors.ts',
    '/src/main.tsx'
  )
  foreach ($target in $warmTargets) {
    $attempts = 0
    while ($attempts -lt 60) {
      $attempts++
      try {
        $response = Invoke-WebRequest "http://127.0.0.1:$port$target" -UseBasicParsing -TimeoutSec 60
        if ($response.StatusCode -eq 200) { break }
      } catch {
        Start-Sleep -Milliseconds 250
      }
    }
  }

  $browserName = [System.IO.Path]::GetFileName($chrome)
  $failure = $null

  for ($index = 0; $index -lt $viewports.Count; $index++) {
    $viewport = $viewports[$index]
    # A fresh debug port per run: the previous browser is gone, but the port can
    # linger long enough for a rebind to be refused.
    $debugPort = $baseDebugPort + $index
    $label = $viewport.Name
    $chromeProfile = Join-Path $env:TEMP "fa-smoke-chrome-$PID-$label"
    $reportPath = Join-Path $env:TEMP "fa-smoke-report-$label.json"

    Write-Host ''
    Write-Host "=== $label viewport ($($viewport.Width)x$($viewport.Height)) ==="
    Write-Host "Launching headless browser ($browserName) ..."

    $chromeProc = Start-Process -FilePath $chrome `
      -ArgumentList @(
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-extensions', '--disable-dev-shm-usage',
        "--window-size=$($viewport.Width),$($viewport.Height)",
        "--remote-debugging-port=$debugPort",
        "--user-data-dir=$chromeProfile", 'about:blank'
      ) -WindowStyle Hidden -PassThru

    try {
      Start-Sleep -Seconds 3

      Write-Host 'Running smoke checks ...'
      # The driver writes the full report to $reportPath and one summary line to
      # stdout; stderr is silenced so console noise cannot pollute the output.
      & node (Join-Path $PSScriptRoot 'cdp-check.mjs') `
        --port $debugPort `
        --url "http://127.0.0.1:$port/?smoke=1" `
        --wait-selector '#smoke-result' `
        --wait-done true `
        --width $viewport.Width `
        --height $viewport.Height `
        --timeout 240000 `
        --out $reportPath 2>$null | Write-Host
      $code = $LASTEXITCODE
      if (-not (Test-Path $reportPath)) {
        throw "browser smoke test wrote no report for $label (driver exit $code)"
      }

      # The driver's stdout contains console text with braces and quotes, so the
      # report is always read from the file. It is read as UTF-8 explicitly: Windows
      # PowerShell 5.1 otherwise decodes it as ANSI, which corrupts non-ASCII page
      # text and breaks JSON parsing.
      $report = [System.IO.File]::ReadAllText($reportPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $panel = $null
      if ($report.panelText) { $panel = $report.panelText | ConvertFrom-Json }

      if ($panel) {
        Write-Host ''
        foreach ($entry in $panel.checks) {
          $mark = if ($entry.ok) { 'PASS' } else { 'FAIL' }
          $extra = if ($entry.detail) { " ($($entry.detail))" } else { '' }
          Write-Host "  [$mark] $($entry.name)$extra"
        }
        Write-Host ''
        Write-Host "Browser smoke ($label): $($panel.passed) passed, $($panel.failed) failed"
      } else {
        Write-Host ''
        Write-Host "Browser smoke ($label): no result panel was produced."
        if ($report.probe) { Write-Host "  last probe: $($report.probe | ConvertTo-Json -Compress)" }
      }

      if ($report.pageErrors -and $report.pageErrors.Count -gt 0) {
        Write-Host 'Page errors:'
        $report.pageErrors | ForEach-Object { Write-Host "  $_" }
      }

      # The assertions live in the page; this decides the exit code, so a failed or
      # unfinished run can never be reported as success.
      if (-not $panel) { throw "browser smoke test produced no results for $label" }
      if ($panel.note -ne 'done') {
        throw "browser smoke test did not finish for $label (last note: '$($panel.note)')"
      }
      if ($panel.failed -gt 0) {
        throw "browser smoke test failed for $label`: $($panel.failed) check(s) did not pass"
      }
      if (-not $report.satisfied) { throw "browser smoke test never reached a finished state for $label" }
      if ($code -ne 0) { throw "browser smoke driver failed for $label (exit $code)" }
    } catch {
      # Keep going so the other viewport is still exercised, then fail at the end.
      Write-Host "FAILED at the $label viewport: $_"
      if (-not $failure) { $failure = $_ }
    } finally {
      if ($chromeProc) { Stop-Process -Id $chromeProc.Id -Force -ErrorAction SilentlyContinue }
      Get-Process -Name 'chrome' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $chrome } |
        ForEach-Object {
          # Only reap the headless instance launched for this profile.
          $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
          if ($cmdline -and $cmdline -like "*$chromeProfile*") { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
        }
      if (Test-Path $chromeProfile) { Remove-Item $chromeProfile -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }

  if ($failure) { throw $failure }

  Write-Host ''
  Write-Host 'Browser smoke test passed at every viewport.'
  $exitCode = 0
} catch {
  Write-Host ''
  Write-Host "Browser smoke test failed: $_"
  $exitCode = 1
} finally {
  # Kill the whole tree.
  #
  # `npx vite` is a wrapper around a node child, and killing only the wrapper leaves
  # that child holding port 5199 alive, which then keeps this script's stdout pipe
  # open and hangs the caller even though every assertion has finished.
  #
  # `taskkill` writes to stderr whenever a process has already exited, and under
  # `ErrorActionPreference = 'Stop'` a native command's stderr output becomes a
  # terminating error. That turned a fully passing run into exit code 1, so the
  # preference is relaxed for the cleanup only.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  foreach ($process in @($vite, $chromeProc)) {
    if ($process) {
      try { & taskkill /PID $process.Id /T /F *> $null } catch { }
    }
  }
  $ErrorActionPreference = $previousPreference
}

exit $exitCode

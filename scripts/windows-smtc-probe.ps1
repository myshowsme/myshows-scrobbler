# Windows System Media Transport Controls (SMTC) probe.
#
# Reads playback state for every app that registers as a media source on Windows
# (VLC, MPC, Windows Media Player, Edge/Chrome with video, Spotify, Films & TV,
# new Media Player). Prints a single JSON line to stdout.
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-smtc-probe.ps1
#
# Output schema:
#   [
#     {
#       "appUserModelId": string,
#       "title": string,
#       "artist": string,
#       "albumTitle": string,
#       "isPlaying": boolean,
#       "positionSeconds": number,
#       "durationSeconds": number
#     },
#     ...
#   ]
#
# Requires Windows 10 1809+ (build 17763+) — `Windows.Media.Control` namespace.
# Earlier builds will print "[]" and exit 0.

$ErrorActionPreference = 'Stop'

# Force UTF-8 on stdout so non-ASCII titles (cyrillic, japanese, ...) survive
# the pipe back to Node. Windows PowerShell 5.1 defaults to the console
# codepage (1251 on RU locale, 1252 on EN, ...), which mangles anything outside
# the active codepage when ConvertTo-Json writes its output.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Emit-Empty {
    Write-Output '[]'
    exit 0
}

# Load the WinRT runtime adapters. Add-Type with -AssemblyName works on PS 5.1+;
# the Windows.Media.Control namespace itself comes from the OS, not the .NET
# install, so no extra SDK is needed.
try {
    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
    [void][Windows.Foundation.IAsyncOperation`1,Windows.Foundation,ContentType=WindowsRuntime]
} catch {
    Emit-Empty
}

# Helper to .GetAwaiter().GetResult() a WinRT IAsyncOperation. PowerShell can't
# `await` natively, so we extract the wrapped task via the AsTask extension.
function Await-WinRT($asyncOp, [Type]$resultType) {
    $asTaskGeneric = ([WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 })[0]
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($asyncOp))
    $task.GetAwaiter().GetResult()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
    Emit-Empty
}

try {
    $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
    $managerAsync = $managerType::RequestAsync()
    $manager = Await-WinRT $managerAsync $managerType
} catch {
    Emit-Empty
}

if (-not $manager) { Emit-Empty }

$sessions = @($manager.GetSessions())
$out = New-Object System.Collections.ArrayList

foreach ($s in $sessions) {
    try {
        $appId = $s.SourceAppUserModelId
        $playbackInfo = $s.GetPlaybackInfo()
        $statusValue = $playbackInfo.PlaybackStatus
        # Enum: Closed=0, Opened=1, Changing=2, Stopped=3, Playing=4, Paused=5
        $isPlaying = $statusValue -eq 'Playing' -or $statusValue.value__ -eq 4

        if (-not $isPlaying -and -not ($statusValue -eq 'Paused' -or $statusValue.value__ -eq 5)) {
            continue
        }

        $mediaPropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
        $mediaPropsAsync = $s.TryGetMediaPropertiesAsync()
        $mediaProps = Await-WinRT $mediaPropsAsync $mediaPropsType

        $title = ''
        $artist = ''
        $albumTitle = ''
        if ($mediaProps) {
            $title = if ($null -ne $mediaProps.Title) { $mediaProps.Title } else { '' }
            $artist = if ($null -ne $mediaProps.Artist) { $mediaProps.Artist } else { '' }
            # Modern Windows Media Player and some streaming apps publish the
            # show name in AlbumTitle (e.g. series title with Title=episode).
            $albumTitle = if ($null -ne $mediaProps.AlbumTitle) { $mediaProps.AlbumTitle } else { '' }
        }

        $timeline = $s.GetTimelineProperties()
        $positionTicks = 0
        $endTicks = 0
        $startTicks = 0
        if ($timeline) {
            $positionTicks = $timeline.Position.Ticks
            $endTicks = $timeline.EndTime.Ticks
            $startTicks = $timeline.StartTime.Ticks
        }
        # Each .NET tick is 100 nanoseconds. Convert to seconds.
        $positionSeconds = [math]::Max(0, ($positionTicks - $startTicks) / 10000000.0)
        $durationSeconds = [math]::Max(0, ($endTicks - $startTicks) / 10000000.0)

        [void]$out.Add([ordered]@{
            appUserModelId = $appId
            title = $title
            artist = $artist
            albumTitle = $albumTitle
            isPlaying = [bool]$isPlaying
            positionSeconds = $positionSeconds
            durationSeconds = $durationSeconds
        })
    } catch {
        continue
    }
}

# ConvertTo-Json wraps single-element arrays in object; force depth + array.
$json = ConvertTo-Json -InputObject @($out) -Compress -Depth 4
if (-not $json) { $json = '[]' }
Write-Output $json

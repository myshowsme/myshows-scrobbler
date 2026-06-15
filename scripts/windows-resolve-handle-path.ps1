# Resolve the full file path of an open media file inside a given process.
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-resolve-handle-path.ps1 `
#       -ProcessId 12345 [-FilenameHint "foo.mkv"] [-Extensions "mkv|mp4|..."]
#
# Output (single line of JSON):
#   {"path":"C:\\full\\path\\foo.mkv"}      # match found
#   {"path":null}                            # nothing useful / not available
#
# How it works:
#   Enumerates every kernel handle on the system via
#   NtQuerySystemInformation(SystemHandleInformation), filters to the target
#   process, duplicates each file-type handle into our own process, and asks
#   the kernel for its final NT path via GetFinalPathNameByHandle. Returns the
#   first handle that ends with `-FilenameHint` (if supplied), or any media
#   file handle otherwise.
#
# This is the canonical, no-config-required way to learn which file a media
# player has open — works for MPC-BE/HC, VLC, mpv, WMP, anything that opens
# the file via the standard Win32 file API. The only alternative on Windows
# without third-party tooling is to ask the player's own IPC (HTTP server),
# which requires the user to enable it.
#
# Caveats:
#   - One handle type number (process, pipe, mutant) varies per Windows build,
#     so we can't pre-filter without risk. Instead we DuplicateHandle every
#     handle and then GetFileType — disk-file handles get FILE_TYPE_DISK=1,
#     everything else is rejected cheaply. The only known hang trigger is the
#     0x0012019F access mask on certain pipe handles; we skip that mask
#     explicitly. Node-side execAsync has a hard timeout as a backstop.
#   - Requires PROCESS_DUP_HANDLE on the target — granted to processes owned
#     by the current user without elevation. Returns null silently otherwise.

param(
    [Parameter(Mandatory)][int]$ProcessId,
    [string]$FilenameHint = '',
    [string]$Extensions = 'mkv|mp4|avi|wmv|flv|mov|webm|m4v|ts|mts|ogv|3gp|divx|xvid|rm|rmvb|asf|mpg|mpeg|m2v|mpe|vob|dvr-ms|wtv|m2ts'
)

$ErrorActionPreference = 'Stop'

# UTF-8 stdout so non-ASCII paths survive the pipe back to Node.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Emit-Null { Write-Output '{"path":null}'; exit 0 }

try {
    Add-Type -ErrorAction Stop @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinHandles {
    // SystemExtendedHandleInformation (class 64). Use this — *not* class 16 —
    // because the legacy SystemHandleInformation truncates pid to 16 bits,
    // which silently breaks on modern Windows where pids routinely go above
    // 65535. Entry layout (x64): Object(8) Pid(8) Handle(8) Access(4)
    // BackTrace(2) ObjectType(2) Attribs(4) Reserved(4) = 40 bytes.
    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    public struct SYSTEM_HANDLE_EX {
        public IntPtr Object;
        public IntPtr UniqueProcessId;
        public IntPtr HandleValue;
        public uint   GrantedAccess;
        public ushort CreatorBackTraceIndex;
        public ushort ObjectTypeIndex;
        public uint   HandleAttributes;
        public uint   Reserved;
    }

    [DllImport("ntdll.dll")]
    public static extern int NtQuerySystemInformation(int sysInfoClass, IntPtr sysInfo, int sysInfoLen, ref int retLen);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DuplicateHandle(IntPtr src, IntPtr h, IntPtr dst, out IntPtr dup, uint access, bool inherit, uint options);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetFileType(IntPtr h);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandle(IntPtr h, StringBuilder buf, uint cch, uint flags);
}
'@
} catch { Emit-Null }

$SystemExtHandleInformation  = 64
$STATUS_INFO_LENGTH_MISMATCH = -1073741820
$PROCESS_DUP_HANDLE          = 0x40
$DUPLICATE_SAME_ACCESS       = 2
$FILE_TYPE_DISK              = 1
# Known hang trigger when duplicating named-pipe handles on some Windows builds.
$PIPE_ACCESS_MASK            = 0x0012019F

$bufSize = 0x100000
$buf     = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bufSize)
$retLen  = 0
$maxBuf  = 128 * 1024 * 1024

try {
    while ($true) {
        $status = [WinHandles]::NtQuerySystemInformation($SystemExtHandleInformation, $buf, $bufSize, [ref]$retLen)
        if ($status -eq 0) { break }
        if ($status -eq $STATUS_INFO_LENGTH_MISMATCH) {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
            $bufSize = [Math]::Min([Math]::Max($bufSize * 2, $retLen + 0x100000), $maxBuf)
            if ($bufSize -ge $maxBuf) { Emit-Null }
            $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bufSize)
            continue
        }
        Emit-Null
    }

    # SYSTEM_HANDLE_INFORMATION_EX header on x64: NumberOfHandles (ULONG_PTR, 8B) + Reserved (ULONG_PTR, 8B) = 16B
    $count       = [System.Runtime.InteropServices.Marshal]::ReadInt64($buf)
    $handleSize  = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinHandles+SYSTEM_HANDLE_EX])
    $entriesBase = 16

    $procHandle  = [WinHandles]::OpenProcess($PROCESS_DUP_HANDLE, $false, $ProcessId)
    if ($procHandle -eq [IntPtr]::Zero) { Emit-Null }

    $current     = [WinHandles]::GetCurrentProcess()
    $hintLower   = $FilenameHint.ToLowerInvariant()
    $mediaRegex  = "\.($Extensions)$"
    $fallback    = $null
    $exactMatch  = $null
    $targetPid   = [IntPtr]::new([int64]$ProcessId)

    for ($i = 0; $i -lt $count; $i++) {
        $offset = $entriesBase + $i * $handleSize
        $infoPtr = [IntPtr]::Add($buf, $offset)
        $info = [System.Runtime.InteropServices.Marshal]::PtrToStructure($infoPtr, [type][WinHandles+SYSTEM_HANDLE_EX])

        if ([int64]$info.UniqueProcessId -ne [int64]$ProcessId) { continue }
        if ($info.GrantedAccess -eq $PIPE_ACCESS_MASK) { continue }

        $dup = [IntPtr]::Zero
        $ok = [WinHandles]::DuplicateHandle($procHandle, $info.HandleValue, $current, [ref]$dup, 0, $false, $DUPLICATE_SAME_ACCESS)
        if (-not $ok -or $dup -eq [IntPtr]::Zero) { continue }

        try {
            if ([WinHandles]::GetFileType($dup) -ne $FILE_TYPE_DISK) { continue }

            $sb = New-Object System.Text.StringBuilder 1024
            $len = [WinHandles]::GetFinalPathNameByHandle($dup, $sb, 1024, 0)
            if ($len -eq 0 -or $len -ge 1024) { continue }

            $path = $sb.ToString()
            if     ($path.StartsWith('\\?\UNC\')) { $path = '\\' + $path.Substring(8) }
            elseif ($path.StartsWith('\\?\'))     { $path = $path.Substring(4) }

            if ($path -notmatch $mediaRegex) { continue }

            $lower = $path.ToLowerInvariant()
            if ($hintLower -and $lower.EndsWith($hintLower)) {
                $exactMatch = $path
                break
            }
            if (-not $fallback) { $fallback = $path }
        } finally {
            [void][WinHandles]::CloseHandle($dup)
        }
    }

    [void][WinHandles]::CloseHandle($procHandle)

    $result = if ($exactMatch) { $exactMatch } else { $fallback }
    if ($result) {
        ConvertTo-Json -Compress -InputObject @{ path = $result }
    } else {
        Emit-Null
    }
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
}

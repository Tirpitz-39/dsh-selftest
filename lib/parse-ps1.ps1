# parse-ps1.ps1 - parse every .ps1 named in a list and report syntax + encoding problems.
#
# Input : -ListFile, a UTF-8 text file holding one absolute path per line.
#         A list file (instead of a -Files array) avoids the 8191-char command
#         line limit and keeps spaces / CJK characters in paths unambiguous.
# Output: one compressed JSON object on stdout:
#         {"files":[{"file":"...","ok":true,"errors":[{"message":"...","line":12}]}]}
# Exit  : 0 always (the JSON carries the verdict), 2 when the list file is missing.
#
# Keep this file ASCII-only: check-ps1.ps1 flags non-ASCII content without a
# UTF-8 BOM, because Windows PowerShell 5.1 reads BOM-less files as ANSI.

param(
  [Parameter(Mandatory = $true)]
  [string]$ListFile
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ListFile -PathType Leaf)) {
  '{"files":[],"error":"list file not found"}'
  exit 2
}

$paths = Get-Content -LiteralPath $ListFile -Encoding utf8 | Where-Object { $_.Trim().Length -gt 0 }
$results = @()

foreach ($raw in $paths) {
  $file = $raw.Trim()
  $entry = [ordered]@{ file = $file; ok = $true; errors = @() }

  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    $entry.ok = $false
    $entry.errors += [ordered]@{ message = 'file not found'; line = 0 }
    $results += [pscustomobject]$entry
    continue
  }

  $tokens = $null
  $parseErrors = $null
  try {
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)
  } catch {
    $entry.ok = $false
    $entry.errors += [ordered]@{ message = $_.Exception.Message; line = 0 }
    $results += [pscustomobject]$entry
    continue
  }

  if ($null -ne $parseErrors -and $parseErrors.Count -gt 0) {
    $entry.ok = $false
    foreach ($e in $parseErrors) {
      $line = 0
      if ($null -ne $e.Extent) { $line = [int]$e.Extent.StartLineNumber }
      $entry.errors += [ordered]@{ message = [string]$e.Message; line = $line }
    }
  }

  # Windows PowerShell 5.1 decodes a BOM-less file as ANSI, so non-ASCII content
  # without a BOM is a real defect even when pwsh 7 parses it fine.
  $bytes = [System.IO.File]::ReadAllBytes($file)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $nonAscii = 0
  foreach ($b in $bytes) { if ($b -gt 127) { $nonAscii++ } }
  if ($nonAscii -gt 0 -and -not $hasBom) {
    $entry.ok = $false
    $entry.errors += [ordered]@{ message = "non-ASCII content without a UTF-8 BOM ($nonAscii bytes); Windows PowerShell 5.1 will misparse it"; line = 0 }
  }

  $results += [pscustomobject]$entry
}

$anyBad = $false
foreach ($one in $results) { if (-not $one.ok) { $anyBad = $true; break } }

[pscustomobject]@{ files = @($results) } | ConvertTo-Json -Depth 6 -Compress

# Exit code carried separately from the JSON on purpose: a confined caller may
# be unable to capture stdout, and the verdict must still survive that.
if ($anyBad) { exit 1 }

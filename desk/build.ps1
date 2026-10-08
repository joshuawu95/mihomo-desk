param([string]$CoreVersion = 'v1.19.32')
$ErrorActionPreference = 'Stop'
$deskRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $deskRoot
$buildRoot = Join-Path $deskRoot '.build'
$releaseRoot = Join-Path $deskRoot 'release'
$outputRoot = Join-Path $releaseRoot 'MihomoDesk-0.1.0-win-x64'
New-Item -ItemType Directory -Force -Path $buildRoot,$outputRoot,(Join-Path $outputRoot 'core'),(Join-Path $outputRoot 'runtime') | Out-Null
Push-Location $deskRoot
try {
    & npm.cmd ci --ignore-scripts --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    $asset = "mihomo-windows-amd64-compatible-$CoreVersion.zip"
    $coreZip = Join-Path $buildRoot $asset
    if (!(Test-Path -LiteralPath $coreZip)) {
        Invoke-WebRequest -Uri "https://github.com/MetaCubeX/mihomo/releases/download/$CoreVersion/$asset" -OutFile $coreZip
    }
    $coreExtract = Join-Path $buildRoot 'core'
    New-Item -ItemType Directory -Force -Path $coreExtract | Out-Null
    Expand-Archive -LiteralPath $coreZip -DestinationPath $coreExtract -Force
    $coreExe = Get-ChildItem -LiteralPath $coreExtract -Filter '*.exe' | Select-Object -First 1
    if (!$coreExe) { throw 'Mihomo executable was not found in the official archive' }
    Copy-Item -LiteralPath $coreExe.FullName -Destination (Join-Path $outputRoot 'core\mihomo.exe') -Force
    $nodeExe = (Get-Command node.exe).Source
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $outputRoot 'runtime\node.exe') -Force
    $nodeLicense = Join-Path (Split-Path -Parent $nodeExe) 'LICENSE'
    if (Test-Path -LiteralPath $nodeLicense) {
        Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $outputRoot 'runtime\LICENSE-Node.txt') -Force
    } else {
        $nodeVersion = & node --version
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $outputRoot 'runtime\LICENSE-Node.txt')
    }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$outputRoot\MihomoDesk.exe" (Join-Path $deskRoot 'Tray.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Tray compilation failed' }
    foreach ($name in @('server.mjs','core.mjs','config.mjs','store.mjs','package.json','package-lock.json','README.md','START.zh-CN.md','THIRD_PARTY.md')) {
        Copy-Item -LiteralPath (Join-Path $deskRoot $name) -Destination $outputRoot -Force
    }
    Copy-Item -LiteralPath (Join-Path $deskRoot 'web') -Destination $outputRoot -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $outputRoot 'node_modules') | Out-Null
    Copy-Item -LiteralPath (Join-Path $deskRoot 'node_modules\yaml') -Destination (Join-Path $outputRoot 'node_modules') -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $outputRoot 'LICENSE') -Force
    $sourceRoot = Join-Path $outputRoot 'source\desk'
    New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
    foreach ($name in @('Tray.cs','build.ps1','server.mjs','core.mjs','config.mjs','store.mjs','package.json','package-lock.json','README.md','START.zh-CN.md','THIRD_PARTY.md','.gitignore','web','test')) {
        Copy-Item -LiteralPath (Join-Path $deskRoot $name) -Destination $sourceRoot -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $outputRoot 'source\LICENSE') -Force
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/MetaCubeX/mihomo/$CoreVersion/LICENSE" -OutFile (Join-Path $outputRoot 'core\LICENSE-Mihomo.txt')
    $manifest = [ordered]@{
        app = '0.1.0'; node = (& node --version); core = $CoreVersion
        coreArchiveSha256 = (Get-FileHash -LiteralPath $coreZip -Algorithm SHA256).Hash
        sourceCommit = (& git rev-parse HEAD)
        sourceDirty = [bool](& git status --porcelain --untracked-files=normal)
        files = @(Get-ChildItem -LiteralPath $outputRoot -Recurse -File | ForEach-Object {
            [ordered]@{ path = $_.FullName.Substring($outputRoot.Length + 1); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
        })
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'build-manifest.json') -Encoding utf8
    $zip = Join-Path $releaseRoot 'MihomoDesk-0.1.0-win-x64.zip'
    Compress-Archive -LiteralPath $outputRoot -DestinationPath $zip -Force
    Write-Output $zip
} finally { Pop-Location }

[CmdletBinding()]
param(
    [string]$Python = "python",
    [string]$WheelDir = ""
)

$ErrorActionPreference = "Stop"
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $WheelDir) {
    $WheelDir = Join-Path $AppRoot "wheels"
}
New-Item -ItemType Directory -Force -Path $WheelDir | Out-Null

& $Python -m pip download `
    --dest $WheelDir `
    --only-binary=:all: `
    --platform manylinux2014_x86_64 `
    --python-version 310 `
    --implementation cp `
    --abi cp310 `
    --no-deps `
    -r (Join-Path $AppRoot "requirements-cu118.txt") `
    -i https://pypi.tuna.tsinghua.edu.cn/simple
if ($LASTEXITCODE -ne 0) { throw "Python dependency download failed" }

$Downloads = @{
    "torch-2.0.1+cu118-cp310-cp310-linux_x86_64.whl" = "https://mirror.sjtu.edu.cn/pytorch-wheels/cu118/torch-2.0.1%2Bcu118-cp310-cp310-linux_x86_64.whl"
    "gsplat-1.5.3+pt20cu118-cp310-cp310-linux_x86_64.whl" = "https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt20cu118-cp310-cp310-linux_x86_64.whl"
}

foreach ($Item in $Downloads.GetEnumerator()) {
    $Destination = Join-Path $WheelDir $Item.Key
    if (Test-Path -LiteralPath $Destination) {
        Write-Host "Already present: $Destination"
        continue
    }
    Invoke-WebRequest -Uri $Item.Value -OutFile $Destination -UseBasicParsing
}

Write-Host "Offline bundle is ready in $WheelDir"

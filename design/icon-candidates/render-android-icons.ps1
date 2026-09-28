# Render the FitAGI by Capy launcher icons from the cat sketch.
#
#   pwsh -File design/icon-candidates/render-android-icons.ps1
#
# The source is the hand-drawn cat, 413x358, with a heart at the top right and a
# fragment of another drawing at the right edge. The crop below keeps the whole cat
# and drops both; everything after that is compositing.
#
# The artwork goes into the adaptive icon's BACKGROUND layer rather than the
# foreground: the sketch is a JPEG with no transparency, so a foreground layer would
# show its own white square on top of the background colour and the seam would be
# visible. As the background layer it is full bleed, and the launcher's mask crops
# paper rather than the cat.
#
# NOTE: this file is ASCII-only and BOM-saved, like the other PowerShell script here,
# because Windows PowerShell 5.1 decodes BOM-less scripts as ANSI.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$res = Join-Path $root 'android\app\src\main\res'
$source = Join-Path $here 'source\cat-sketch.jpg'
$cropOut = Join-Path $here 'source\cat-crop.png'

if (-not (Test-Path $source)) { throw "missing source image: $source" }

# Crop window: the cat, without the heart or the fragment at the right edge.
$crop = [System.Drawing.Rectangle]::new(0, 8, 350, 350)

$origin = [System.Drawing.Bitmap]::FromFile($source)

# Sample the paper colour just inside the corners, so the icon's padding matches the
# sketch instead of guessing at "white".
function Get-PaperColour([System.Drawing.Bitmap]$bitmap) {
  $samples = @(
    @(4, 4), @(400, 4), @(4, 350), @(400, 350), @(200, 350), @(400, 200)
  )
  $r = 0; $g = 0; $b = 0
  foreach ($s in $samples) {
    $x = [Math]::Min([Math]::Max($s[0], 0), $bitmap.Width - 1)
    $y = [Math]::Min([Math]::Max($s[1], 0), $bitmap.Height - 1)
    $pixel = $bitmap.GetPixel($x, $y)
    $r += $pixel.R; $g += $pixel.G; $b += $pixel.B
  }
  $count = $samples.Count
  return [System.Drawing.Color]::FromArgb(255, [int]($r / $count), [int]($g / $count), [int]($b / $count))
}

$paper = Get-PaperColour $origin
Write-Host ("paper colour: #{0:X2}{1:X2}{2:X2}" -f $paper.R, $paper.G, $paper.B)

# The cropped cat, kept as a PNG so the icon render is reproducible without the JPEG.
$cat = [System.Drawing.Bitmap]::new($crop.Width, $crop.Height)
$catGraphics = [System.Drawing.Graphics]::FromImage($cat)
$catGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$catGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$catGraphics.DrawImage(
  $origin,
  [System.Drawing.Rectangle]::new(0, 0, $crop.Width, $crop.Height),
  $crop,
  [System.Drawing.GraphicsUnit]::Pixel
)
$catGraphics.Dispose()

<#
  Deepen the drawing a little.

  It is a pale pencil sketch: at 48px the fur all but disappears against the paper. A
  gamma above 1 darkens the midtones (the fur and the outlines) while leaving the
  near-white paper alone, which is separation without touching the artwork's colours.
  A contrast curve would have done the opposite here: the fur is a light grey above
  mid-grey, so more contrast would have pushed it further towards white.
#>
$gamma = 1.35
$adjusted = [System.Drawing.Bitmap]::new($cat.Width, $cat.Height)
$adjustedGraphics = [System.Drawing.Graphics]::FromImage($adjusted)
$adjustedGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$attributes = [System.Drawing.Imaging.ImageAttributes]::new()
$attributes.SetGamma($gamma)
$adjustedGraphics.DrawImage(
  $cat,
  [System.Drawing.Rectangle]::new(0, 0, $cat.Width, $cat.Height),
  0, 0, $cat.Width, $cat.Height,
  [System.Drawing.GraphicsUnit]::Pixel,
  $attributes
)
$adjustedGraphics.Dispose()
$attributes.Dispose()
$cat.Dispose()
$cat = $adjusted

# Re-sample the paper from the adjusted artwork so the icon's padding is exactly the
# colour of the crop's own edges: no visible square where the two meet.
$paper = Get-PaperColour $cat
Write-Host ("paper colour after gamma {0}: #{1:X2}{2:X2}{3:X2}" -f $gamma, $paper.R, $paper.G, $paper.B)

$cat.Save($cropOut, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "cropped, adjusted cat written: $cropOut ($($crop.Width)x$($crop.Height))"

<#
  Compose one icon.

  `scale` is the share of the canvas the cat occupies. 0.86 fills a plain square
  icon; 0.74 is what the adaptive safe zone allows (the guaranteed-visible area is the
  central 72 of 108dp, and a circular mask is inscribed in that).
#>
function New-Icon {
  param(
    [int]$Size,
    [double]$Scale,
    [bool]$Circle,
    [string]$Path
  )

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  if ($Circle) {
    # A round legacy icon must not show a square of paper in its corners.
    $brush = [System.Drawing.SolidBrush]::new($paper)
    $graphics.FillEllipse($brush, 0, 0, $Size - 1, $Size - 1)
    $brush.Dispose()
  } else {
    $graphics.Clear($paper)
  }

  $side = [int]($Size * $Scale)
  $offset = [int](($Size - $side) / 2)
  # DrawImage with a Graphics destination rect resamples with the mode set above, so
  # every density goes through the same high-quality path.
  $graphics.DrawImage(
    $cat,
    [System.Drawing.Rectangle]::new($offset, $offset, $side, $side),
    0, 0, $cat.Width, $cat.Height,
    [System.Drawing.GraphicsUnit]::Pixel
  )
  $graphics.Dispose()

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Host ("  {0}  ({1}x{1}, cat at {2:P0})" -f $Path.Replace($root + '\', ''), $Size, $Scale)
}

# The adaptive foreground stays empty: the artwork is in the background layer, so a
# foreground would only be a second copy of it. Android requires the element to exist
# in the descriptor, hence a transparent image rather than no file at all.
function New-Transparent {
  param([int]$Size, [string]$Path)
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.Dispose()
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

# Launcher icons are 48dp, adaptive layers are 108dp.
$densities = @(
  @{ dir = 'mipmap-mdpi'; launcher = 48; adaptive = 108 },
  @{ dir = 'mipmap-hdpi'; launcher = 72; adaptive = 162 },
  @{ dir = 'mipmap-xhdpi'; launcher = 96; adaptive = 216 },
  @{ dir = 'mipmap-xxhdpi'; launcher = 144; adaptive = 324 },
  @{ dir = 'mipmap-xxxhdpi'; launcher = 192; adaptive = 432 }
)

Write-Host 'Rendering launcher icons:'
foreach ($density in $densities) {
  $target = Join-Path $res $density.dir
  New-Icon -Size $density.launcher -Scale 0.88 -Circle $false -Path (Join-Path $target 'ic_launcher.png')
  New-Icon -Size $density.launcher -Scale 0.78 -Circle $true -Path (Join-Path $target 'ic_launcher_round.png')
  New-Icon -Size $density.adaptive -Scale 0.78 -Circle $false -Path (Join-Path $target 'ic_launcher_background.png')
  New-Transparent -Size $density.adaptive -Path (Join-Path $target 'ic_launcher_foreground.png')
}

$cat.Dispose()
$origin.Dispose()
Write-Host 'done'

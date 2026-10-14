# Speak a text file into a WAV with a built-in Windows voice.
#   powershell -File tts.ps1 <in.txt> <out.wav> [voice]
param([string]$In, [string]$Out, [string]$Voice = "Microsoft Zira Desktop")
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($Voice)
$s.Rate = 0
$s.SetOutputToWaveFile($Out)
$s.Speak([IO.File]::ReadAllText($In))
$s.Dispose()

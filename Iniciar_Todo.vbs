Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = dir
WshShell.Run """" & dir & "\Iniciar_Web.bat""", 0, False
WScript.Sleep 3000
WshShell.Run """" & dir & "\Iniciar_Tunel.bat""", 0, False

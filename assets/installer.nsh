; インストール開始前に既存プロセスを自動終了させる
; 「手動で閉じてください」ダイアログを回避するため
!macro customInstall
  nsExec::ExecToLog 'taskkill /F /IM "Obsidian Optimizer.exe" /T'
  Sleep 500
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /F /IM "Obsidian Optimizer.exe" /T'
  Sleep 500
!macroend

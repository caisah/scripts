# Fork current OpenCode session into a new iTerm2 tab
ocfork() {
    osascript <<EOF
    tell application "iTerm"
        if exists current window then
            tell current window
                create tab with default profile
                tell current session
                    write text "opencode -c --fork"
                end tell
            end tell
        else
            create window with default profile
            tell current session of current window
                write text "opencode -c --fork"
            end tell
        end if
    end tell
EOF
}

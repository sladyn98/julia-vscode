# julia

[![Join the chat at https://gitter.im/JuliaEditorSupport/julia-vscode](https://badges.gitter.im/JuliaEditorSupport/julia-vscode.svg)](https://gitter.im/JuliaEditorSupport/julia-vscode?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)

This [VS Code](https://code.visualstudio.com) extension provides support for the [julia programming language](http://julialang.org/).

## Getting started

Once the extension is installed it needs to find the julia binary on your system. There are two options: if your julia binary is on the path and you have not configured something else, the extension will use that version of julia. Alternatively, you can set the ``julia.executablePath`` configuration setting to point to a julia binary, in which case the extension will always use that version of julia. To edit your configuration settings, execute the ``Preferences: Open User Settings`` command, and then make sure your user settings include the ``julia.executablePath`` setting. The format of the string should follow your platform specific conventions, and be aware that the backlash ``\`` is the escape character in JSON, so you need to use ``\\`` as the path separator character on Windows.

### Note for MacOS Users
When setting your ``julia.executablePath``, you need to make sure that you are linking to the correct executable within your ``julia-x.x.app`` folder. The correct executable is located at
```
[Path to applications folder]/Julia-x.x.app/Contents/Resources/julia/bin/julia
```
### Note on auto-indentation
Starting from VS Code 1.14 auto indentation is available. Until it becomes the default behaviour, you need to enable this feature manually by setting ``editor.autoIndent: true`` in your User Settings (see also #37).

## Features

The extension currently provides

* syntax highlighting
* snippets
* [latex snippets](https://github.com/JuliaEditorSupport/julia-vscode/wiki/Snippets#latex)
* [julia specific commands](https://github.com/JuliaEditorSupport/julia-vscode/wiki/Commands)
* [integrated julia REPL](https://github.com/JuliaEditorSupport/julia-vscode/wiki/REPL)
* [code completion](https://github.com/JuliaEditorSupport/julia-vscode/wiki/IntelliSense)
* [hover help](https://github.com/JuliaEditorSupport/julia-vscode/wiki/Information#hover-help)
* [a linter](https://github.com/JuliaEditorSupport/julia-vscode/wiki/Information#linter)
* [code navigation](https://github.com/JuliaEditorSupport/julia-vscode/wiki/Navigation)
* test run command

## Development information

The file julia.tmLanguage for this extension was generated by running the [Yo Code - Extension Generator](https://code.visualstudio.com/docs/tools/yocode) for VS Code with this [Julia.tmLanguage file](https://github.com/JuliaLang/Julia.tmbundle/blob/696f630736669251a3cb56cb27741b5b07a4c093/Syntaxes/Julia.tmLanguage) as input.

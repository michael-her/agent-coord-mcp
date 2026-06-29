# gnd-client

C++ terminal UI for the agent-coord bus (FTXUI + Chafa). Part of the AiRPG workspace — not a separate repository.

## Build

Requires Visual Studio 2022+ (MSBuild, x64), vcpkg manifest mode, and the **chafa** submodule (`gnd/chafa` → [michael-her/chafa](https://github.com/michael-her/chafa)):

```sh
git submodule update --init gnd/chafa   # skip if you cloned with --recurse-submodules
msbuild gnd/gnd.sln /p:Configuration=Debug /p:Platform=x64
```

Output: `gnd/x64/Debug/gnd.exe`

## Run

```sh
gnd/x64/Debug/gnd.exe --id sehui --dir %USERPROFILE%\agent-coord
```

Do not run with the same `--id` as `coord-chat` at the same time. See root `README.md` and `AGENTS.md` for chat commands.

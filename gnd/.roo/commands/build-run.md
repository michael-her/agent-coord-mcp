---
description: "MSBuild로 솔루션 디버그 빌드 수행 후 target을 실행"
---

```bash
msbuild gnd.sln /p:Configuration=Debug
cd gnd-client
..\x64\Debug\gnd.exe
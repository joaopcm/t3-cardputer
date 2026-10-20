# third party

## cardputer-adv-template

firmware skeleton (CMakeLists.txt, sdkconfig.defaults, main/app_main.cpp, keyboard bring-up) derived from https://github.com/podrivo/cardputer-adv-template at 116259d1eaa8939e36803501bbb3daf26aead319.

```
MIT License

Copyright (c) 2026 Pedro Ivo Hudson @podrivo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pinned at build time (not vendored, fetched by the IDF component manager, see firmware/main/idf_component.yml and firmware/dependencies.lock)

- M5GFX 0.2.33 (MIT) https://github.com/m5stack/M5GFX
- M5Unified 0.2.27 (MIT) https://github.com/m5stack/M5Unified
- ESP-IDF v5.4.2 (Apache-2.0) https://github.com/espressif/esp-idf

## vendored for host tests (test/host/third_party, license headers kept in the files)

- doctest 2.4.11 (MIT)
- cJSON 1.7.18 (MIT)

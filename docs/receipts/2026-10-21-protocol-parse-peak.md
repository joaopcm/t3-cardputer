# relay frame parse peak

Receipt for `parseRelay` memory (`firmware/components/t3core/protocol.cpp`). Measured on the host, 64-bit glibc, by the test `parse peak table for docs/receipts (host 64-bit upper bound)` in `firmware/test/host/protocol_test.cpp` (run `firmware/test/host/build/host_tests -tc="parse peak*"`). Device pointers are 4 bytes and cJSON nodes are smaller, so these are upper bounds. Task 8 re-measures on the ADV with `heap_caps` and replaces this table.

- `tree`: peak bytes requested by cJSON through the t3core allocator hook (`setJsonAllocator`), not counting malloc overhead.
- `typed`: live bytes of the parsed `RelayMsg` left after the call (`mallinfo2` delta, includes malloc overhead and vector slack).
- `total`: tree + typed. Both are alive at the same time while the typed copy is built, so this is the peak.
- Caps for the run: cols 40, bodyRows 11, maxFrameBytes 65536, maxHomeRows 255 (the widest the relay allows), so no frame was rejected.

| frame | frame bytes | tree | typed | total | total / frame |
| --- | --- | --- | --- | --- | --- |
| home, 255 rows (11 char project, 20 char title) | 28938 | 124467 | 50592 | 175059 | 6.0x |
| home, 8 rows | 1027 | 4672 | 1520 | 6192 | 6.0x |
| home, 16 warnings of 120 chars | 2089 | 3768 | 5120 | 8888 | 4.3x |
| home, 1000 empty warnings (degenerate) | 3121 | 66792 | 0 | 66792 | 21.4x |
| thread_page, 11 lines of 40 | 638 | 2010 | 1536 | 3546 | 5.6x |
| request, 7 lines + 4 options | 607 | 2473 | 304 | 2777 | 4.6x |
| projects, 255 items | 37514 | 148115 | 28432 | 176547 | 4.7x |

## reading it

- Real frames cost 4x to 6x their size. The degenerate warnings frame costs 21x because each `""` is a 3-byte frame fragment and a 64-byte cJSON node. `warnings` copies are cut at `kWarningsMax` = 16, so only the tree is paid for it.
- The parser rejects, before copying anything: a frame over `hello.maxFrameBytes`, `rows`/`items` over `hello.maxHomeRows`, `lines`/`options` over `hello.bodyRows` (and their sum for a request). A frame over `maxFrameBytes` is rejected before cJSON allocates a byte (test `a frame over the declared cap is rejected before anything is allocated`).
- The tree is bounded by `maxFrameBytes` times the ratio above, so the worst a relay can make the device spend is about 21 x `maxFrameBytes` for a frame of empty elements, and the worst honest frame is about 6 x. With the design's `maxFrameBytes` of about 4096 that is about 24 KB honest and about 88 KB degenerate, against a 311296-byte largest block at boot (`2026-10-21-firmware-baseline.md`). Task 8 sets `maxFrameBytes` from the device measurement and records the real peak here.
- An allocation failure inside cJSON is reported as `heap: parse needed more than available, frame was N bytes`, not as invalid json, and an encoder that cannot allocate returns no frame.

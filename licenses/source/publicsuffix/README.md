# Public Suffix List source for OkHttp 4.12.0

The adjacent unmodified `public_suffix_list.dat` is from the exact OkHttp release source, not today's changing list. Its original MPL-2.0 notice and contributor comments remain intact. See [MPL-2.0](../../MPL-2.0.txt) and [the source/binary digest record](../../../release/public-suffix-source.json).

Recipients receive this editable source with the complete MeloCanvas source archive, at no additional charge. The list retains MPL-2.0; MeloCanvas's MIT and OC asset terms do not replace it. The original list project is https://publicsuffix.org/.

`scripts/lib/public-suffix-source.cjs` reconstructs OkHttp's sorted UTF-8 rule and exception payload from the text. The reconstructed payload has been compared byte for byte with the actual 4.12.0 Maven JAR, and APK verification checks the packaged resource again. GZIP container metadata is not part of the editable list data. Modification of the list requires retaining its license/notices and supplying the corresponding modified source with distribution.

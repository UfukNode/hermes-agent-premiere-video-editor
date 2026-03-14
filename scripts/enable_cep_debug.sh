#!/bin/sh
set -eu

for version in 8 9 10 11 12; do
  defaults write "com.adobe.CSXS.$version" PlayerDebugMode 1
done

killall cfprefsd >/dev/null 2>&1 || true

echo "Enabled PlayerDebugMode for CSXS 8-12."
echo "Restart Premiere Pro before testing the CEP panel."

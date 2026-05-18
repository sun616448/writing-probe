#!/bin/bash
rm -f thinking-probe.zip
zip -r thinking-probe.zip chrome-extension/ -x "*.DS_Store"
echo "Done — thinking-probe.zip is ready to upload."

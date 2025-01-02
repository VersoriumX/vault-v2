#!/bin/sh
find $1 -name "*.swift" ! -path "$1/R.generated.swift" -print0 | xargs -0 xcrun extractLocStrings

scripts/tools/lokalise --token $2 import  --file Localizable.strings --lang_iso en 
scripts/tools/lokalise --token $2 export  --type strings --bundle_structure %LANG_ISO%.lproj/Localizable.%FORMAT% --export_empty base
unzip -o Trust-Localizable.zip -d $1/Localization

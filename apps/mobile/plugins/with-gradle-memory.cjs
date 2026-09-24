"use strict"

// Gives Gradle the memory a release build of the app needs. The template
// starts the Gradle daemon with a 2 GiB heap and 512 MiB of metaspace; on a
// CI runner that ran out while D8 merged the libraries' dex files
// (`:app:mergeExtDexRelease`, "OutOfMemoryError: Java heap space").

const { withGradleProperties } = require("expo/config-plugins")

const JVM_ARGS = "-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8"

/** gradle.properties entries with `org.gradle.jvmargs` set to JVM_ARGS. */
function setGradleMemory(properties) {
  const others = properties.filter(
    (entry) => !(entry.type === "property" && entry.key === "org.gradle.jvmargs")
  )
  return [...others, { type: "property", key: "org.gradle.jvmargs", value: JVM_ARGS }]
}

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (next) => {
    next.modResults = setGradleMemory(next.modResults)
    return next
  })
}
module.exports.JVM_ARGS = JVM_ARGS
module.exports.setGradleMemory = setGradleMemory

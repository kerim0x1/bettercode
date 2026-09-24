import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const { JVM_ARGS, setGradleMemory } = require("../apps/mobile/plugins/with-gradle-memory.cjs")

test("Gradle gets a 4 GiB heap and 1 GiB of metaspace instead of the template's 2 GiB and 512 MiB", () => {
  const properties = setGradleMemory([
    { type: "comment", value: "Specifies the JVM arguments used for the daemon process." },
    { type: "property", key: "org.gradle.jvmargs", value: "-Xmx2048m -XX:MaxMetaspaceSize=512m" },
    { type: "property", key: "android.useAndroidX", value: "true" },
  ])
  const jvmArgs = properties.filter((entry) => entry.key === "org.gradle.jvmargs")
  assert.deepEqual(jvmArgs, [{ type: "property", key: "org.gradle.jvmargs", value: JVM_ARGS }])
  assert.match(JVM_ARGS, /-Xmx4096m/)
  assert.match(JVM_ARGS, /-XX:MaxMetaspaceSize=1024m/)
  // Everything else stays as the template wrote it.
  assert.ok(properties.some((entry) => entry.key === "android.useAndroidX" && entry.value === "true"))
  assert.ok(properties.some((entry) => entry.type === "comment"))
})

test("the setting is added when the template has none", () => {
  assert.deepEqual(setGradleMemory([]), [{ type: "property", key: "org.gradle.jvmargs", value: JVM_ARGS }])
})

test("the app's config applies the plugin", () => {
  const config = fs.readFileSync(path.join(import.meta.dirname, "..", "apps", "mobile", "app.config.ts"), "utf8")
  assert.match(config, /"\.\/plugins\/with-gradle-memory\.cjs"/)
})

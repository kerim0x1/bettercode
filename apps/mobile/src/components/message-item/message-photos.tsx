import { useState } from "react"
import { Image, Modal, Pressable, StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { X } from "lucide-react-native"
import type { ChatAttachment } from "@betterc0de/schema/chat-attachment"
import { colors, radius, spacing } from "@/design/theme"

const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i

/**
 * The attachments shown as pictures: images carried in the message itself.
 * An image behind a web address is not loaded (that would tell its server
 * the phone's address); it counts as a file.
 */
export function shownPhotos(
  attachments: readonly ChatAttachment[] | undefined
): ChatAttachment[] {
  return (attachments ?? []).filter((attachment) =>
    INLINE_IMAGE.test(attachment.url)
  )
}

/** A message's photos as thumbnails; one opens full screen when tapped. */
export function MessagePhotos({
  attachments,
}: {
  attachments: readonly ChatAttachment[] | undefined
}) {
  const [open, setOpen] = useState<ChatAttachment | null>(null)
  const photos = shownPhotos(attachments)
  if (photos.length === 0) return null
  return (
    <View style={styles.row} testID="message-photos">
      {photos.map((photo, index) => (
        <Pressable
          key={`${index}-${photo.filename ?? ""}`}
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open photo ${index + 1}`}
          onPress={() => setOpen(photo)}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Image source={{ uri: photo.url }} style={styles.thumbnail} />
        </Pressable>
      ))}
      <Modal
        visible={open !== null}
        animationType="fade"
        onRequestClose={() => setOpen(null)}
      >
        <SafeAreaView style={styles.viewer} testID="photo-viewer">
          {open ? (
            <Image
              source={{ uri: open.url }}
              style={styles.full}
              resizeMode="contain"
              accessibilityLabel={open.filename ?? "Photo"}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close photo"
            testID="photo-viewer-close"
            hitSlop={12}
            onPress={() => setOpen(null)}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <X size={20} color={colors.text} />
          </Pressable>
        </SafeAreaView>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  thumbnail: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  viewer: { flex: 1, backgroundColor: colors.canvas },
  full: { flex: 1 },
  close: {
    position: "absolute",
    top: spacing.xl,
    right: spacing.md,
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceActive,
  },
  pressed: { opacity: 0.72 },
})

import * as ImagePicker from "expo-image-picker"
import {
  ImageManipulator,
  SaveFormat,
  type ImageRef,
} from "expo-image-manipulator"
import { createId } from "./ids"
import {
  MAX_PHOTOS_PER_MESSAGE,
  encodePhoto,
  type PhotoCodec,
  type PreparedPhoto,
} from "./photos"

/**
 * Photos for a message, from the photo library or the camera. The library
 * opens the system's photo picker, which needs no access to the library;
 * the camera asks for the camera permission, the same one the pairing
 * scanner uses. Each photo is decoded and encoded again as a JPEG
 * (photos.ts), so only its pixels leave the phone.
 */

export type PhotoSource = "library" | "camera"

export interface PickedPhotos {
  photos: PreparedPhoto[]
  /** Why a chosen photo was not added, or `null`. */
  problem: string | null
}

export const NO_ROOM_FOR_PHOTO =
  "There is no room for another photo in this message. Send it with the next one."

export const CAMERA_NOT_ALLOWED =
  "BetterC0de Remote may not use the camera. Allow it in the phone's Settings to take a photo."

/**
 * Lets the user choose photos (or take one) and prepares them to send.
 * `maxBytesFor` says how large the next photo may be, given the message's
 * photos so far (`nextPhotoMaxBytes`); a photo that cannot be made that
 * small is left out, with the reason in `problem`.
 */
export async function pickPhotos(
  source: PhotoSource,
  current: readonly PreparedPhoto[],
  maxBytesFor: (photos: readonly PreparedPhoto[]) => number
): Promise<PickedPhotos> {
  const room = MAX_PHOTOS_PER_MESSAGE - current.length
  if (room <= 0 || maxBytesFor(current) <= 0)
    return { photos: [], problem: NO_ROOM_FOR_PHOTO }

  let result: ImagePicker.ImagePickerResult
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) return { photos: [], problem: CAMERA_NOT_ALLOWED }
    result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1,
      exif: false,
    })
  } else {
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: room > 1,
      selectionLimit: room,
      orderedSelection: true,
      quality: 1,
      exif: false,
    })
  }
  if (result.canceled) return { photos: [], problem: null }

  const added: PreparedPhoto[] = []
  let problem: string | null = null
  for (const asset of result.assets) {
    const maxBytes = maxBytesFor([...current, ...added])
    if (maxBytes <= 0) {
      problem = NO_ROOM_FOR_PHOTO
      break
    }
    let encoded: Awaited<ReturnType<typeof encodePhoto>>
    try {
      encoded = await encodeFile(asset.uri, maxBytes)
    } catch (error) {
      problem = `A photo could not be read: ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    if (!encoded) {
      problem = NO_ROOM_FOR_PHOTO
      continue
    }
    added.push({ id: createId("photo"), ...encoded })
  }
  return { photos: added, problem }
}

/** Decodes the photo once, upright, and encodes it at each size tried. */
async function encodeFile(uri: string, maxBytes: number) {
  const context = ImageManipulator.manipulate(uri)
  const rendered: ImageRef[] = []
  try {
    const original = await context.renderAsync()
    rendered.push(original)
    let sized: { width: number; height: number; image: ImageRef } | null = null
    const codec: PhotoCodec = {
      width: original.width,
      height: original.height,
      async jpeg(width, height, quality) {
        if (!sized || sized.width !== width || sized.height !== height) {
          const image =
            width === original.width && height === original.height
              ? original
              : await context.reset().resize({ width, height }).renderAsync()
          if (image !== original) rendered.push(image)
          sized = { width, height, image }
        }
        const saved = await sized.image.saveAsync({
          format: SaveFormat.JPEG,
          compress: quality,
          base64: true,
        })
        if (!saved.base64) throw new Error("the phone did not encode it")
        return saved.base64
      },
    }
    return await encodePhoto(codec, maxBytes)
  } finally {
    for (const image of rendered) image.release()
    context.release()
  }
}

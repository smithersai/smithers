/**
 * Byte encoding for the vector projection table.
 *
 * @since 0.1.0
 */

/**
 * Encodes Float32 vector values explicitly in little-endian byte order.
 *
 * @category encoding
 * @since 0.1.0
 */
export const vectorBytes = (vector: ArrayLike<number>): Uint8Array => {
  const bytes = new Uint8Array(vector.length * 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < vector.length; index++) {
    view.setFloat32(index * 4, vector[index]!, true)
  }
  return bytes
}

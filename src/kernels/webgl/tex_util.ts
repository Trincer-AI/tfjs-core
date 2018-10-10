/**
 * @license
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {Tensor} from '../../tensor';
import {DataType, DataTypeMap} from '../../types';
import * as util from '../../util';

export enum TextureUsage {
  RENDER,
  UPLOAD,
  PIXELS,
  DOWNLOAD,
  PACK
}

export enum PhysicalTextureType {
  UNPACKED_FLOAT16,
  UNPACKED_FLOAT32,
  PACKED_4X1_UNSIGNED_BYTE,
  PACKED_2X2_FLOAT32
}

export interface TextureData {
  texture: WebGLTexture;
  // For complex numbers, the real and imaginary parts are stored as their own
  // individual tensors, with a parent joining the two with the
  // complexTensors field. When this is defined, texture will be null.
  complexTensors?: {real: Tensor, imag: Tensor};

  shape: number[];
  /** [rows, columns] shape of the texture. */
  texShape: [number, number];
  dtype: DataType;
  values: DataTypeMap[DataType];
  usage: TextureUsage;
}

export function getUnpackedMatrixTextureShapeWidthHeight(
    rows: number, columns: number): [number, number] {
  return [columns, rows];
}

export function getUnpackedArraySizeFromMatrixSize(
    matrixSize: number, channelsPerTexture: number): number {
  return matrixSize * channelsPerTexture;
}

export function getColorMatrixTextureShapeWidthHeight(
    rows: number, columns: number): [number, number] {
  return [columns * 4, rows];
}

export function getMatrixSizeFromUnpackedArraySize(
    unpackedSize: number, channelsPerTexture: number): number {
  if (unpackedSize % channelsPerTexture !== 0) {
    throw new Error(
        `unpackedSize (${unpackedSize}) must be a multiple of ` +
        `${channelsPerTexture}`);
  }
  return unpackedSize / channelsPerTexture;
}

export type TypedArray = Float32Array|Uint8Array;

export function encodeMatrixToUnpackedArray(
    matrix: TypedArray, unpackedArray: TypedArray, channelsPerTexture: number) {
  const requiredSize =
      getUnpackedArraySizeFromMatrixSize(matrix.length, channelsPerTexture);
  if (unpackedArray.length < requiredSize) {
    throw new Error(
        `unpackedArray length (${unpackedArray.length}) must be >= ` +
        `${requiredSize}`);
  }
  let dst = 0;
  for (let src = 0; src < matrix.length; ++src) {
    unpackedArray[dst] = matrix[src];
    dst += channelsPerTexture;
  }
}

export function decodeMatrixFromUnpackedArray(
    unpackedArray: Float32Array, matrix: Float32Array,
    channelsPerTexture: number) {
  const requiredSize = getMatrixSizeFromUnpackedArraySize(
      unpackedArray.length, channelsPerTexture);
  if (matrix.length < requiredSize) {
    throw new Error(
        `matrix length (${matrix.length}) must be >= ${requiredSize}`);
  }
  let dst = 0;
  for (let src = 0; src < unpackedArray.length; src += channelsPerTexture) {
    matrix[dst++] = unpackedArray[src];
  }
}

export function decodeMatrixFromUnpackedColorRGBAArray(
    unpackedArray: Float32Array, matrix: Float32Array, channels: number) {
  const requiredSize = unpackedArray.length * channels / 4;
  if (matrix.length < requiredSize) {
    throw new Error(
        `matrix length (${matrix.length}) must be >= ${requiredSize}`);
  }
  let dst = 0;
  for (let src = 0; src < unpackedArray.length; src += 4) {
    for (let c = 0; c < channels; c++) {
      matrix[dst++] = unpackedArray[src + c];
    }
  }
}

export function getPackedMatrixTextureShapeWidthHeight(
    rows: number, columns: number): [number, number] {
  return [Math.ceil(columns / 2), Math.ceil(rows / 2)];
}

export function getPackedRGBAArraySizeFromMatrixShape(
    rows: number, columns: number): number {
  const [w, h] = getPackedMatrixTextureShapeWidthHeight(rows, columns);
  return w * h * 4;
}

export function encodeMatrixToPackedRGBA(
    matrix: Float32Array, rows: number, columns: number,
    packedRGBA: Float32Array) {
  const requiredSize = getPackedRGBAArraySizeFromMatrixShape(rows, columns);
  if (packedRGBA.length < requiredSize) {
    throw new Error(
        `packedRGBA length (${packedRGBA.length}) must be >= ${requiredSize}`);
  }
  /*
    Unpacked matrix, row-major order in Float32Array[16]:  A B C D
                                                           E F G H
                                                           I J K L
                                                           M N O P

    Packed matrix, 2x2 RGBA32 texture (memory view):       ABEF CDGH IJMN KLOP

    Packed matrix, 2x2 RGBA32 texture (matrix view):       AB|CD
                                                           EF|GH
                                                           --+--
                                                           IJ|KL
                                                           MN|OP
   */
  const [textureWidth, textureHeight] =
      getPackedMatrixTextureShapeWidthHeight(rows, columns);
  const oddWidth = (columns % 2) === 1;
  const oddHeight = (rows % 2) === 1;
  const widthInFullBlocks = Math.floor(columns / 2);
  const heightInFullBlocks = Math.floor(rows / 2);

  // loop over full 2x2 blocks
  {
    const dstStride = (oddWidth ? 4 : 0);
    const oneRow = columns;
    let dst = 0;
    for (let blockY = 0; blockY < heightInFullBlocks; ++blockY) {
      const matrixSrcRow = (blockY * 2 * columns);
      for (let blockX = 0; blockX < widthInFullBlocks; ++blockX) {
        const matrixSrcCol = blockX * 2;
        const src = matrixSrcRow + matrixSrcCol;
        packedRGBA[dst] = matrix[src];
        packedRGBA[dst + 1] = matrix[src + 1];
        packedRGBA[dst + 2] = matrix[src + oneRow];
        packedRGBA[dst + 3] = matrix[src + oneRow + 1];
        dst += 4;
      }
      dst += dstStride;
    }
  }

  // loop down final odd column
  if (oddWidth) {
    let src = columns - 1;
    let dst = (textureWidth - 1) * 4;
    const srcStride = 2 * columns;
    const dstStride = textureWidth * 4;
    for (let blockY = 0; blockY < heightInFullBlocks; ++blockY) {
      packedRGBA[dst] = matrix[src];
      packedRGBA[dst + 2] = matrix[src + columns];
      src += srcStride;
      dst += dstStride;
    }
  }

  // loop across final row
  if (oddHeight) {
    let src = (rows - 1) * columns;
    let dst = (textureHeight - 1) * textureWidth * 4;
    for (let blockX = 0; blockX < widthInFullBlocks; ++blockX) {
      packedRGBA[dst++] = matrix[src++];
      packedRGBA[dst++] = matrix[src++];
      dst += 2;
    }
  }

  // fill in bottom-right texel
  if (oddWidth && oddHeight) {
    packedRGBA[packedRGBA.length - 4] = matrix[matrix.length - 1];
  }

  return packedRGBA;
}

export function decodeMatrixFromPackedRGBA(
    packedRGBA: Float32Array, batches: number, rows: number, columns: number,
    matrix: Float32Array, textureWidth: number,
    textureHeight: number): Float32Array {
  const requiredSize = rows * columns;
  if (matrix.length < requiredSize) {
    throw new Error(
        `matrix length (${matrix.length}) must be >= ${requiredSize}`);
  }

  const oddWidth = (columns % 2) === 1;
  const oddHeight = (rows % 2) === 1;
  const widthInFullBlocks = Math.floor(columns / 2);
  const heightInFullBlocks = Math.floor(rows / 2);
  const srcStride = oddWidth ? 4 : 0;
  const dstStride = columns + (oddWidth ? 1 : 0);

  const texelsPerRow = Math.ceil(columns / 2);
  const texelsPerBatch = texelsPerRow * Math.ceil(rows / 2);

  const flattenedMatrixSize =
      util.nearestEven(rows) * util.nearestEven(columns);

  for (let batch = 0; batch < batches; batch++) {
    const batchOffset = batch * rows * columns;
    const sourceOffset = batch * flattenedMatrixSize;

    // loop over full 2x2 blocks
    {
      let src = sourceOffset;
      let dstRow1 = batchOffset;
      let dstRow2 = batchOffset + columns;
      for (let blockY = 0; blockY < heightInFullBlocks; ++blockY) {
        for (let blockX = 0; blockX < widthInFullBlocks; ++blockX) {
          matrix[dstRow1++] = packedRGBA[src++];
          matrix[dstRow1++] = packedRGBA[src++];
          matrix[dstRow2++] = packedRGBA[src++];
          matrix[dstRow2++] = packedRGBA[src++];
        }
        src += srcStride;
        dstRow1 += dstStride;
        dstRow2 += dstStride;
      }
    }

    // loop down final column
    if (oddWidth) {
      let src = sourceOffset + (texelsPerRow - 1) * 4;
      let dst = batchOffset + columns - 1;
      const srcStride = texelsPerRow * 4;
      const dstStride = 2 * columns;
      for (let blockY = 0; blockY < heightInFullBlocks; ++blockY) {
        matrix[dst] = packedRGBA[src];
        matrix[dst + columns] = packedRGBA[src + 2];
        src += srcStride;
        dst += dstStride;
      }
    }

    // loop across final row
    if (oddHeight) {
      let src = sourceOffset + (texelsPerBatch - texelsPerRow) * 4;
      let dst = batchOffset + (rows - 1) * columns;
      for (let blockX = 0; blockX < widthInFullBlocks; ++blockX) {
        matrix[dst++] = packedRGBA[src++];
        matrix[dst++] = packedRGBA[src++];
        src += 2;
      }

      // fill in bottom-right cell
      if (oddWidth) {
        matrix[batchOffset + (rows * columns) - 1] = packedRGBA[src];
      }
    }
  }

  return matrix;
}

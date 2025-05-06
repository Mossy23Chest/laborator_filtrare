/**
 * WAV file parser module
 *
 * Provides utilities to extract raw PCM audio samples from WAV files and
 * compressed audio formats (using FFmpeg). This is used for audio analysis
 * and visualization in the spectrogram views.
 */
import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';
import * as FileSystem from 'expo-file-system';

/**
 * Interface for PCM data result
 * @typedef {Object} PCMDataResult
 * @property {Float32Array} samples - Mono audio samples normalized to [-1, 1]
 * @property {Float32Array} [originalSamples] - Original audio samples (may be stereo)
 * @property {number} sampleRate - Sample rate in Hz
 * @property {number} numChannels - Number of audio channels
 * @property {number} numSamples - Number of samples (per channel for monoSamples)
 * @property {number} [bitsPerSample] - Bits per sample (WAV only)
 * @property {number} duration - Duration in seconds
 */

/**
 * Extracts raw PCM data from a WAV file encoded as a base64 string.
 * Handles various bit depths (8, 16, 24, 32-bit PCM, 32-bit Float) and both mono and stereo formats.
 * For stereo files, returns both the original stereo samples and a mono mixdown.
 *
 * @param {string} base64Data - Base64 encoded WAV file data
 * @returns {PCMDataResult} Object containing normalized samples, sample rate, and other WAV info
 * @throws {Error} If the WAV file is invalid or uses an unsupported format
 */
export function extractRawPCMFromWAV(base64Data) {
  try {
    // Convert base64 string to an ArrayBuffer for easier byte-level access.
    const binary = atob(base64Data); // Decode base64 string to binary string
    const bytes = new Uint8Array(binary.length); // Create Uint8Array from binary string length
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i); // Fill the array with character codes
    }

    // Create a DataView to read multi-byte data types (like integers) from the ArrayBuffer.
    const buffer = bytes.buffer;
    const dataView = new DataView(buffer);

    // --- WAV Header Parsing ---

    // 1. Verify RIFF Header (Bytes 0-3)
    // All valid WAV files start with the ASCII characters "RIFF".
    const riffHeader = String.fromCharCode(
      dataView.getUint8(0), dataView.getUint8(1), dataView.getUint8(2), dataView.getUint8(3)
    );
    if (riffHeader !== 'RIFF') {
      console.error('Invalid WAV file: Missing RIFF header.');
      throw new Error('Invalid WAV file: No RIFF header');
    }

    // 2. Verify WAVE Format Identifier (Bytes 8-11)
    // The format identifier "WAVE" should follow the RIFF chunk size.
    const waveHeader = String.fromCharCode(
      dataView.getUint8(8), dataView.getUint8(9), dataView.getUint8(10), dataView.getUint8(11)
    );
    if (waveHeader !== 'WAVE') {
      console.error('Invalid WAV file: Missing WAVE format identifier.');
      throw new Error('Invalid WAV file: No WAVE format');
    }

    // 3. Find the 'fmt ' Sub-chunk
    // WAV files are composed of chunks. We need the 'fmt ' chunk containing audio format details.
    // Chunks have a 4-byte ID and a 4-byte size field.
    let fmtOffset = 12; // Start searching after "RIFFxxxxWAVE"
    let fmtHeader = '';
    let fmtFound = false;
    while (fmtOffset < buffer.byteLength - 8) { // Ensure space for ID and size
      const chunkId = String.fromCharCode(
        dataView.getUint8(fmtOffset), dataView.getUint8(fmtOffset + 1),
        dataView.getUint8(fmtOffset + 2), dataView.getUint8(fmtOffset + 3)
      );

      if (chunkId === 'fmt ') {
        fmtFound = true;
        break; // Found the 'fmt ' chunk
      }

      // If not 'fmt ', skip this chunk to find the next one.
      const chunkSize = dataView.getUint32(fmtOffset + 4, true); // Read chunk size (little-endian)
      fmtOffset += 8 + chunkSize; // Move offset past this chunk (ID + Size + Data)
      // Add padding byte if chunk size is odd (WAV chunks are word-aligned)
      if (chunkSize % 2 !== 0) {
          fmtOffset++;
      }
    }

    if (!fmtFound) {
      console.error('Invalid WAV file: Could not find "fmt " chunk.');
      throw new Error('Invalid WAV file: No "fmt " chunk');
    }

    // 4. Parse Audio Format Information from 'fmt ' chunk
    // const fmtChunkSize = dataView.getUint32(fmtOffset + 4, true); // Size of the fmt data (e.g., 16 for basic PCM)
    const audioFormat = dataView.getUint16(fmtOffset + 8, true); // 1 = PCM, 3 = IEEE float
    const numChannels = dataView.getUint16(fmtOffset + 10, true); // 1 = mono, 2 = stereo
    const sampleRate = dataView.getUint32(fmtOffset + 12, true); // Samples per second (e.g., 44100)
    // const byteRate = dataView.getUint32(fmtOffset + 16, true); // sampleRate * numChannels * bitsPerSample / 8
    // const blockAlign = dataView.getUint16(fmtOffset + 20, true); // numChannels * bitsPerSample / 8
    const bitsPerSample = dataView.getUint16(fmtOffset + 22, true); // 8, 16, 24, 32

    console.log('Parsed WAV format info:', {
      audioFormat, numChannels, sampleRate, bitsPerSample
    });

    // 5. Find the 'data' Sub-chunk
    // This chunk contains the actual raw audio samples.
    let dataOffset = 12; // Start search from beginning again (could be before or after 'fmt ')
    let dataFound = false;
    let dataChunkSize = 0;
    while (dataOffset < buffer.byteLength - 8) {
      const chunkId = String.fromCharCode(
        dataView.getUint8(dataOffset), dataView.getUint8(dataOffset + 1),
        dataView.getUint8(dataOffset + 2), dataView.getUint8(dataOffset + 3)
      );
      const chunkSize = dataView.getUint32(dataOffset + 4, true);

      if (chunkId === 'data') {
        dataFound = true;
        dataChunkSize = chunkSize; // Size of the audio data in bytes
        dataOffset += 8; // Move offset to the beginning of the actual data
        break; // Found the 'data' chunk
      }

      // If not 'data', skip this chunk
      dataOffset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) {
          dataOffset++;
      }
    }

    if (!dataFound) {
      console.error('Invalid WAV file: Could not find "data" chunk.');
      throw new Error('Invalid WAV file: No "data" chunk');
    }

    console.log(`Found PCM data chunk at offset ${dataOffset}, size: ${dataChunkSize} bytes`);

    // --- PCM Sample Extraction and Normalization ---

    // Calculate the total number of samples based on data size, channels, and bit depth.
    const bytesPerSample = bitsPerSample / 8;
    const totalSamples = dataChunkSize / bytesPerSample; // Total samples across all channels
    const numSamplesPerChannel = totalSamples / numChannels;

    console.log(`Calculated samples: Total=${totalSamples}, Per Channel=${numSamplesPerChannel}`);

    if (numSamplesPerChannel <= 0) {
        console.error("No samples found in data chunk.");
        throw new Error("Invalid WAV file: Data chunk is empty");
    }

    // Create a Float32Array to store the normalized samples (all channels interleaved).
    const samples = new Float32Array(totalSamples);
    let sampleIndex = 0;

    // Read and normalize samples based on bit depth. Assumes Little-Endian format.
    for (let i = 0; i < totalSamples; i++) {
      const currentByteOffset = dataOffset + i * bytesPerSample;

      // Prevent reading past the end of the data chunk or buffer
      if (currentByteOffset + bytesPerSample > dataOffset + dataChunkSize || currentByteOffset + bytesPerSample > buffer.byteLength) {
         console.warn(`Attempted to read past data chunk end at sample index ${i}. Stopping extraction.`);
         break;
      }

      let rawValue;
      let normalizedValue;

      switch (bitsPerSample) {
        case 8:
          // 8-bit PCM is unsigned (0-255). Normalize to [-1.0, 1.0] by centering around 128.
          rawValue = dataView.getUint8(currentByteOffset);
          normalizedValue = (rawValue - 128) / 128.0;
          break;
        case 16:
          // 16-bit PCM is signed (-32768 to 32767). Normalize by dividing by 32768.
          rawValue = dataView.getInt16(currentByteOffset, true); // true = little-endian
          normalizedValue = rawValue / 32768.0;
          break;
        case 24:
          // 24-bit PCM (3 bytes per sample). Combine bytes, handle sign, normalize by 2^23.
          const b0 = dataView.getUint8(currentByteOffset);
          const b1 = dataView.getUint8(currentByteOffset + 1);
          const b2 = dataView.getUint8(currentByteOffset + 2);
          // Combine bytes into 24-bit value (treat as signed)
          rawValue = (b2 << 16) | (b1 << 8) | b0;
          // Sign extend if the highest bit (bit 23) is set
          if (rawValue & 0x800000) {
            rawValue = rawValue | ~0xFFFFFF; // Extend the sign to 32 bits (equivalent to rawValue - (1 << 24))
          }
          normalizedValue = rawValue / 8388608.0; // Normalize by 2^23
          break;
        case 32:
          if (audioFormat === 1) {
            // 32-bit Integer PCM (signed). Normalize by 2^31.
            rawValue = dataView.getInt32(currentByteOffset, true);
            normalizedValue = rawValue / 2147483648.0;
          } else if (audioFormat === 3) {
            // 32-bit Floating Point PCM. Already in [-1.0, 1.0] range (usually).
            rawValue = dataView.getFloat32(currentByteOffset, true);
            normalizedValue = rawValue; // Assume it's already normalized
          } else {
            throw new Error(`Unsupported 32-bit WAV format type: ${audioFormat}`);
          }
          break;
        default:
          throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
      }
      // Store the normalized sample, ensuring it's within the [-1, 1] range.
      samples[sampleIndex++] = Math.max(-1.0, Math.min(1.0, normalizedValue));
    }

     // If fewer samples were read than expected (e.g., due to stopping early), adjust array size.
    const actualExtractedSamples = sampleIndex;
    const finalSamples = samples.slice(0, actualExtractedSamples);
    const actualNumSamplesPerChannel = Math.floor(actualExtractedSamples / numChannels);

    console.log(`Successfully extracted ${actualExtractedSamples} total samples (${actualNumSamplesPerChannel} per channel).`);

    // --- Mono Conversion (if needed) ---
    let monoSamples = finalSamples;
    if (numChannels > 1) {
      console.log(`Converting ${numChannels}-channel audio to mono.`);
      monoSamples = new Float32Array(actualNumSamplesPerChannel);
      // Average samples across channels for each time point.
      for (let i = 0; i < actualNumSamplesPerChannel; i++) {
        let sum = 0;
        for (let ch = 0; ch < numChannels; ch++) {
          sum += finalSamples[i * numChannels + ch];
        }
        monoSamples[i] = sum / numChannels;
      }
      console.log("Mono conversion complete.");
    }

    // --- Return Result ---
    return {
      samples: monoSamples,                 // Mono samples for analysis/spectrogram
      originalSamples: finalSamples,        // Original samples (interleaved if multi-channel)
      sampleRate: sampleRate,               // Audio sample rate
      numChannels: numChannels,             // Original number of channels
      bitsPerSample: bitsPerSample,         // Original bit depth
      numSamples: actualNumSamplesPerChannel, // Number of samples *per channel* in monoSamples
      duration: actualNumSamplesPerChannel / sampleRate // Duration in seconds
    };

  } catch (error) {
    console.error('Error extracting PCM data from WAV:', error);
    throw error; // Re-throw the error to be caught by the caller
  }
}

/**
 * Extracts raw PCM data from a compressed audio file (MP3/AAC/MP4 etc.)
 * by first converting it to WAV using FFmpeg, then parsing the WAV data.
 *
 * @param {string} inputUri - The URI of the compressed audio file
 * @returns {Promise<PCMDataResult | null>} A promise resolving to the PCM data or null on failure
 */
export async function extractRawPCMFromCompressed(inputUri) {
  console.log(`Attempting to extract PCM from compressed file: ${inputUri}`);
  // Create a unique temporary filename in the app's cache directory.
  const outputWavUri = `${FileSystem.cacheDirectory}temp_output_${Date.now()}.wav`;

  try {
    // FFmpeg command to convert the input file to a standardized WAV format:
    // -i "${inputUri}": Specifies the input file URI. Quotes handle spaces in paths.
    // -acodec pcm_s16le: Sets the audio codec to 16-bit signed little-endian PCM.
    // -ar 44100: Sets the audio sample rate to 44100 Hz.
    // -ac 1: Sets the number of audio channels to 1 (mono).
    // "${outputWavUri}": Specifies the output file URI.
    // This standardization ensures consistent input for our WAV parser and spectrogram generation.
    const command = `-i \"${inputUri}\" -acodec pcm_s16le -ar 44100 -ac 1 \"${outputWavUri}\"`;
    console.log(`Executing FFmpeg command: ${command}`);

    // Execute the FFmpeg command asynchronously using the ffmpeg-kit-react-native library.
    const session = await FFmpegKit.execute(command);
    // Get the return code from the FFmpeg process once it finishes.
    const returnCode = await session.getReturnCode();

    // Check if the FFmpeg process completed successfully.
    if (ReturnCode.isSuccess(returnCode)) {
      console.log('FFmpeg conversion to WAV successful.');

      // Read the contents of the newly created temporary WAV file.
      // Read as base64 because our WAV parser expects base64 input.
      const wavData = await FileSystem.readAsStringAsync(outputWavUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      console.log(`Read temporary WAV file (${wavData.length} base64 chars).`);

      // Parse the base64 WAV data using our 'extractRawPCMFromWAV' function.
      const pcmData = extractRawPCMFromWAV(wavData);
      console.log(`Successfully parsed PCM data from temporary WAV file.`);

      // Clean up: Delete the temporary WAV file as it's no longer needed.
      // `idempotent: true` prevents an error if the file doesn't exist for some reason.
      await FileSystem.deleteAsync(outputWavUri, { idempotent: true });
      console.log('Cleaned up temporary WAV file.');

      // Return the structured PCM data object.
      return pcmData;

    } else if (ReturnCode.isCancel(returnCode)) {
      // Handle the case where the FFmpeg process was explicitly cancelled.
      console.warn('FFmpeg conversion cancelled.');
      return null;
    } else {
      // Handle FFmpeg conversion failure (any non-success, non-cancel code).
      console.error(`FFmpeg conversion failed with return code ${returnCode}`);
      // Retrieve and log FFmpeg's output (stdout/stderr) for debugging purposes.
      const logs = await session.getLogsAsString();
      console.error('FFmpeg logs:\n', logs);
      // Attempt to clean up the temporary file even if conversion failed (it might be partially created).
      await FileSystem.deleteAsync(outputWavUri, { idempotent: true });
      return null; // Indicate failure by returning null.
    }
  } catch (error) {
    // Catch any other unexpected errors during the process (e.g., file system errors, library issues).
    console.error('Error during FFmpeg conversion or WAV processing:', error);
    // Ensure the temporary file is cleaned up even if an error occurs.
    await FileSystem.deleteAsync(outputWavUri, { idempotent: true });
    return null; // Indicate failure by returning null.
  }
}
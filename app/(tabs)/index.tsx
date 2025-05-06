import React, { useState, useRef, useEffect, createContext } from 'react';
import { FlatList, Text, View, StyleSheet, Button, Pressable, Alert, Platform, PermissionsAndroid, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { Sound } from 'expo-av/build/Audio';
import RecordListItem from '@/components/sunet/recordListItem';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import AudioRecord from 'react-native-audio-record';
import { Buffer } from 'buffer';
import { ensureFFmpegLoaded } from '@/utils/ffmpeg';
import { extractRawPCMFromCompressed, extractRawPCMFromWAV } from '@/utils/wav_parser';

// Create a context to share spectrogram loading state across components
// This allows child components (like RecordListItem) to know if a spectrogram
// is being generated anywhere in the app and disable interactions accordingly.
export const AppStateContext = createContext<{
  isSpectrogramGenerating: boolean;
  setIsSpectrogramGenerating: React.Dispatch<React.SetStateAction<boolean>>;
}>({
  isSpectrogramGenerating: false,
  setIsSpectrogramGenerating: () => {},
});

// Interface for PCM data from wav_parser.js
// Since JavaScript doesn't export the TypeScript definitions, we'll use 'any' type
// and trust the documentation in wav_parser.js

// Updated SoundRecording interface
// Defines the structure for storing information about each audio recording.
export interface SoundRecording {
  uri: string; // Path to the audio file
  metering: number[]; // Simplified visual representation of amplitude (used for waveform display)
  exactFrequency?: number; // Stores the frequency if it's a generated sine wave
  rawSamples?: Float32Array | null; // Raw PCM audio samples (preferred for analysis)
  duration?: number; // Duration of the recording in milliseconds
  isConverting?: boolean; // Flag to indicate if FFmpeg conversion is in progress
}

// Helper function to write a string into a DataView at a specific offset.
// Used for creating the WAV header text fields.
function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// Creates a valid WAV file header based on audio parameters.
function createWavHeader({
  sampleRate = 44100,
  numChannels = 1,
  bitDepth = 16,
  dataLength = 0, // Length of the raw PCM data in bytes
}) {
  const header = new ArrayBuffer(44); // Standard WAV header size
  const view = new DataView(header);

  const blockAlign = (numChannels * bitDepth) / 8; // Bytes per sample block (all channels)
  const byteRate = sampleRate * blockAlign; // Bytes per second

  // RIFF Chunk Descriptor
  writeString(view, 0, 'RIFF'); // ChunkID
  view.setUint32(4, 36 + dataLength, true); // ChunkSize (file size - 8 bytes for ChunkID and ChunkSize)
  writeString(view, 8, 'WAVE'); // Format

  // "fmt " Sub-chunk
  writeString(view, 12, 'fmt '); // Subchunk1ID
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitDepth, true); // BitsPerSample

  // "data" Sub-chunk
  writeString(view, 36, 'data'); // Subchunk2ID
  view.setUint32(40, dataLength, true); // Subchunk2Size (size of the actual sound data)

  return new Uint8Array(header);
}

// Encodes raw 16-bit integer PCM samples into a full WAV file format (Uint8Array).
function encodeWav(int16Samples: Int16Array, sampleRate: number = 44100, numChannels: number = 1): Uint8Array {
  const header = createWavHeader({
    sampleRate,
    numChannels,
    bitDepth: 16,
    dataLength: int16Samples.length * 2, // Each 16-bit sample is 2 bytes
  });

  // Create the final buffer: header + PCM data
  const wavBuffer = new Uint8Array(header.length + int16Samples.length * 2);
  wavBuffer.set(header, 0); // Copy header to the start

  // Write the 16-bit PCM data (Little Endian)
  for (let i = 0; i < int16Samples.length; i++) {
    // Lower byte
    wavBuffer[44 + i * 2] = int16Samples[i] & 0xff;
    // Upper byte
    wavBuffer[44 + i * 2 + 1] = (int16Samples[i] >> 8) & 0xff;
  }

  return wavBuffer;
}

// Main component for the recording list screen.
export default function Sunet() {
  // State to hold the list of all sound recordings.
  const [recordList, setRecordList] = useState<SoundRecording[]>([]);
  // State to hold the currently loaded/playing sound object for playback control.
  const [activeSound, setActiveSound] = useState<Sound | null>(null);
  // State to track which recordings are selected for simultaneous playback (currently unused feature?).
  const [selectedReplays, setSelectedReplays] = useState<string[]>([]);
  // State to indicate if the FFmpeg library is currently loading.
  const [isFFmpegLoading, setIsFFmpegLoading] = useState(false);
  // State to track if audio recording is currently in progress.
  const [isRecording, setIsRecording] = useState(false);
  // Ref to accumulate raw audio data chunks received during recording.
  const accumulatedBuffers = useRef<Buffer[]>([]);
  // State to track if spectrogram generation is in progress globally (shared via context)
  const [isSpectrogramGenerating, setIsSpectrogramGenerating] = useState(false);

  // Effect to reset spectrogram generating state when the screen gains focus
  useFocusEffect(
    React.useCallback(() => {
      console.log("Sunet screen focused, resetting isSpectrogramGenerating.");
      setIsSpectrogramGenerating(false);
    }, [])
  );

  // Preload FFmpeg on component mount to avoid delays later.
  useEffect(() => {
    const loadFFmpeg = async () => {
      try {
        setIsFFmpegLoading(true);
        await ensureFFmpegLoaded();
        console.log('FFmpeg preloaded successfully');
      } catch (error) {
        console.error('Error preloading FFmpeg:', error);
        Alert.alert(
          'FFmpeg Error',
          'Failed to load audio processing library. Some features may not work properly.'
        );
      } finally {
        setIsFFmpegLoading(false);
      }
    };

    loadFFmpeg();
  }, []); // Empty dependency array ensures this runs only once on mount.

  // === Permission Handling ===
  // Removed useEffect for initial permission check
  // Permissions are now requested inline before starting recording.
  // const checkPermissions = async () => { ... }; // Removed function
  // === End Permission Handling ===

  // Generates a sine wave, saves it as a WAV file, and adds it to the record list.
  const generateSineWave = async (frequency: number = 10000, duration: number = 2) => {
    try {
      console.log('Starting sine wave generation...');
      const sampleRate = 44100;
      const numSamples = sampleRate * duration;
      // Create raw floating-point samples (-1 to 1)
      const floatSamples = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        // Use cosine for phase consistency if needed, Math.sin also works
        floatSamples[i] = Math.cos(2 * Math.PI * frequency * i / sampleRate);
      }

      // Convert float samples to 16-bit signed integers for WAV format.
      const int16Samples = new Int16Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        // Clamp values between -1 and 1 before scaling to 16-bit range
        int16Samples[i] = Math.max(-1, Math.min(1, floatSamples[i])) * 0x7FFF; // 0x7FFF = 32767
      }

      // Encode the 16-bit samples into a WAV file buffer.
      const wavBuffer = encodeWav(int16Samples, sampleRate, 1);

      // Create a unique filename for the generated wave.
      const timestamp = Date.now();
      const fileName = `sine-wave-${frequency}Hz-${timestamp}.wav`;
      const filePath = `${FileSystem.documentDirectory}${fileName}`;

      // Convert the WAV buffer (Uint8Array) to a base64 string for saving.
      // This is inefficient for large files but common for FileSystem API.
      let binary = '';
      for (let i = 0; i < wavBuffer.length; i++) {
        binary += String.fromCharCode(wavBuffer[i]);
      }
      const base64Data = btoa(binary); // Base64 encoding

      // Save the base64 encoded WAV data to the file system.
      await FileSystem.writeAsStringAsync(
        filePath,
        base64Data,
        { encoding: FileSystem.EncodingType.Base64 }
      );

      console.log('Sine wave saved to:', filePath);

      // Store the original Float32Array samples for accurate analysis later.
      const rawSamples = floatSamples;

      // Generate simple metering data (placeholder) for the visual waveform display.
      // Sine waves don't have varying amplitude, so a flat line is sufficient visually.
      const visualMeteringSamples = 50; // Number of lines for visual waveform
      const visualMeteringData: number[] = new Array(visualMeteringSamples).fill(-20); // Arbitrary dB level

      // Add the new sine wave recording to the beginning of the record list.
      setRecordList((existingRecords) => [
        {
          uri: filePath,
          metering: visualMeteringData, // Use placeholder metering
          exactFrequency: frequency,
          rawSamples: rawSamples // Store the precise raw samples
        },
        ...existingRecords
      ]);

      return filePath; // Return the path of the saved file
    } catch (error) {
      console.error('Error generating sine wave:', error);
      return null;
    }
  };

  // Handles the button press to generate a sine wave.
  const handleSineWaveGeneration = async () => {
    try {
      console.log('Starting sine wave generation process...');
      const fileUri = await generateSineWave(); // Call the generation function
      if (fileUri) {
        console.log('Sine wave generated successfully with URI:', fileUri);
        Alert.alert(
          'Sine Wave Generated',
          `Sine wave successfully created and saved to:
${fileUri}
You can now select it to play and view its spectrogram.`
        );
      } else {
        console.error('Sine wave generation returned null URI');
        Alert.alert('Error', 'Failed to generate sine wave - null URI returned');
      }
    } catch (error: any) {
      console.error('Error handling sine wave generation:', error);
      Alert.alert('Error', `Failed to generate sine wave: ${error.message || 'Unknown error'}`);
    }
  };

  // Skips the currently active sound playback backward by 1 second.
  async function skipBackward() {
    if (!activeSound) return; // No sound loaded
    const status = await activeSound.getStatusAsync();
    if (!status.isLoaded) return; // Sound not ready

    let newPosition = status.positionMillis - 1000; // Go back 1000ms
    if (newPosition < 0) newPosition = 0; // Don't go below 0

    await activeSound.setPositionAsync(newPosition); // Set the new position
  }

  // Skips the currently active sound playback forward by 1 second.
  async function skipForward() {
    if (!activeSound) return; // No sound loaded
    const status = await activeSound.getStatusAsync();
    if (!status.isLoaded || !status.durationMillis) return; // Sound not ready or duration unknown

    let newPosition = status.positionMillis + 1000; // Go forward 1000ms
    // Don't go beyond the total duration
    if (newPosition > status.durationMillis) newPosition = status.durationMillis;

    await activeSound.setPositionAsync(newPosition); // Set the new position
  }

  // Starts the audio recording process.
  async function startRecording() {
    if (isRecording) {
      console.log('Already recording, cannot start again.');
      return;
    }

    // Request microphone permission directly before starting (Android specific).
    if (Platform.OS === 'android') {
      try {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
        );
        console.log('RECORD_AUDIO Permission grant:', result);
        const recordAudioGranted = result === PermissionsAndroid.RESULTS.GRANTED;
        if (!recordAudioGranted) {
          console.log('Microphone permission not granted');
          Alert.alert(
            'Permissions Required',
            'Please grant microphone permission to record audio.',
            [{ text: 'OK' }]
          );
          return false; // Stop if permission not granted
        } else {
          console.log('Microphone permission granted for recording');
        }
    } catch (err) {
        console.error('Error requesting permissions:', err);
        Alert.alert('Error', 'Failed to request required permissions.');
        return false; // Stop on error
      }
    } // Add similar logic for iOS if needed using Info.plist configuration.

    // Clear any previously accumulated audio data.
    accumulatedBuffers.current = [];
    console.log('Cleared accumulated data.');

    // Configure the audio recorder.
    const options = {
      sampleRate: 44100,
      channels: 1, // Mono
      bitsPerSample: 16, // 16-bit PCM
      audioSource: 1, // Specifies the microphone input source (Android specific, check library docs for details)
      wavFile: 'temp_recording.wav' // Temporary file name used by the library (may not be the final saved file)
    };
    console.log('AudioRecord options:', options);

    try {
      // Initialize the recorder with the specified options.
      AudioRecord.init(options);
      console.log('AudioRecord initialized.');

      // Set up a listener to receive audio data chunks as they become available.
      AudioRecord.on('data', (data: string) => {
        console.log(`Received data chunk, length: ${data ? data.length : 'null/undefined'}`);
        if (data) {
          // Decode the base64 chunk immediately and store it as a Buffer.
          accumulatedBuffers.current.push(Buffer.from(data, 'base64'));
        } else {
          console.warn("Received null or undefined data chunk!");
        }
      });

      // Start the actual recording process.
      console.log('Starting AudioRecord...');
      AudioRecord.start();
      setIsRecording(true); // Update state to reflect recording status
      console.log('Recording started with react-native-audio-record.');

      return true; // Indicate success

    } catch (error: any) {
      console.error('Failed to initialize or start AudioRecord:', error);
      Alert.alert('Recording Error', `Failed to start recorder: ${error.message || 'Unknown error'}`);
      setIsRecording(false); // Ensure state is reset on failure
      return false; // Indicate failure
    }
  }

  // Stops the audio recording and processes the collected data.
  async function stopRecording() {
    if (!isRecording) {
      console.log('Not recording, cannot stop.');
      return false; // Indicate failure or no action needed
    }

    console.log('Stopping AudioRecord...');
    try {
      // Stop the native recording module. It might return a path to a temporary file.
      const audioFile = await AudioRecord.stop();
      console.log('AudioRecord stopped. Received audioFile path (might be temporary): ', audioFile);
      setIsRecording(false); // Update recording state

      // Check if any audio data was actually captured.
      if (accumulatedBuffers.current.length === 0) {
        console.warn("No audio data buffers were accumulated.");
        // Potentially delete the temporary file if 'audioFile' path is valid and empty
        // await FileSystem.deleteAsync(audioFile, { idempotent: true });
        return false; // Indicate no data was processed
      }

      // Concatenate all the received audio data buffers into one single Buffer.
      console.log(`Concatenating ${accumulatedBuffers.current.length} accumulated buffers.`);
      const finalBuffer = Buffer.concat(accumulatedBuffers.current);
      accumulatedBuffers.current = []; // Clear the buffer reference
      console.log(`Final concatenated buffer length: ${finalBuffer.length} bytes`);

      // --- Process the final concatenated Buffer --- 

      // Calculate the number of samples based on 16-bit depth (2 bytes per sample).
      const numSamples = finalBuffer.length / 2;
      console.log(`Calculated number of samples: ${numSamples}`);
      if (numSamples === 0) {
        console.error('Final buffer contains 0 samples.');
        // Potentially delete the temporary file
        // await FileSystem.deleteAsync(audioFile, { idempotent: true });
        return false; // Indicate empty data
      }

      // Convert the raw Buffer data directly into an Int16Array (signed 16-bit integers).
      // Assumes Little Endian byte order, which is standard for WAV.
      const int16Samples = new Int16Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        int16Samples[i] = finalBuffer.readInt16LE(i * 2); // Read 2 bytes as Little Endian signed int
      }
      console.log(`Converted final buffer to Int16Array with ${int16Samples.length} samples.`);

      // Convert the Int16Array to a Float32Array, normalizing samples to the range [-1.0, 1.0].
      // This format is preferred for audio analysis and spectrogram generation.
      const float32Samples = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        float32Samples[i] = int16Samples[i] / 32768.0; // Normalize by 2^15
      }
      console.log(`Converted Int16Array to Float32Array.`);

      // Encode the Int16Array data into a proper WAV format buffer using our helper.
      const wavBuffer = encodeWav(int16Samples, 44100, 1);
      console.log(`Encoded WAV buffer length: ${wavBuffer.length} bytes`);

      // --- Save the processed WAV file ---
      const timestamp = Date.now();
      const fileName = `recording-${timestamp}.wav`; // Use WAV extension
      const filePath = `${FileSystem.documentDirectory}${fileName}`; // Save in app's document directory

      // Convert the WAV Uint8Array buffer to a base64 string for saving via FileSystem API.
      let binaryWav = '';
      for (let i = 0; i < wavBuffer.length; i++) {
        binaryWav += String.fromCharCode(wavBuffer[i]);
      }
      const base64WavData = btoa(binaryWav);

      // Write the base64 encoded WAV data to the file system.
      await FileSystem.writeAsStringAsync(
        filePath,
        base64WavData,
        { encoding: FileSystem.EncodingType.Base64 }
      );
      console.log('WAV file saved to:', filePath);

      // Estimate the recording duration in milliseconds from the number of samples.
      const durationMs = (numSamples / 44100) * 1000;

      // Add the newly saved recording to the beginning of the record list state.
      setRecordList((prevList) => [
        {
          uri: filePath, // Path to the saved WAV file
          metering: [], // Metering data is not directly available from this library; could be calculated from rawSamples if needed
          duration: durationMs, // Calculated duration
          rawSamples: float32Samples // Store the high-fidelity Float32 samples
        },
        ...prevList,
      ]);
      console.log('Recording added to list with processed raw samples.');

      // Optionally, delete the temporary file created by AudioRecord if path is valid
      // if (audioFile && audioFile !== filePath) {
      //    await FileSystem.deleteAsync(audioFile, { idempotent: true });
      // }

      return true; // Indicate success

    } catch (err: unknown) {
      console.error('Failed to stop recording or process data:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      Alert.alert('Recording Error', `Failed to stop recording: ${errorMessage}`);
      setIsRecording(false); // Ensure state is reset on error
      accumulatedBuffers.current = []; // Clear potentially partial data on error
      return false; // Indicate failure
    }
  }

  // Function called by RecordListItem to remove a recording from the list state.
  const handleDeleteRecording = (uriToDelete: string) => {
    console.log("Deleting recording with URI:", uriToDelete);
    setRecordList((currentList) => 
      currentList.filter((recording) => recording.uri !== uriToDelete)
    );
    // Additionally, if the deleted sound was the active one, clear the activeSound state.
    if (activeSound) {
      activeSound.getStatusAsync().then(status => {
        if (status.isLoaded && status.uri === uriToDelete) {
          activeSound.unloadAsync(); // Unload it
          setActiveSound(null); // Clear the state
          console.log("Unloaded active sound because it was deleted.");
        }
      }).catch(error => {
        console.error("Error checking status of active sound during delete:", error);
        // Might still want to clear activeSound state as a precaution
        setActiveSound(null);
      });
    }
  };

  // Allows the user to select an audio file from the device's storage.
  async function pickAudioFile() {
    try {
      // Open the document picker, filtering for audio files.
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*', // Show only audio files
        copyToCacheDirectory: true, // Copy the selected file to the app's cache for easier access
      });
  
      // Check if the user selected a file.
      if (result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        const uri = asset.uri; // URI of the copied file in the app's cache
        console.log('Selected file:', uri);
        
        // Determine if the selected file is already a WAV file.
        const isWavFile = asset.uri.toLowerCase().endsWith('.wav') ||
          (asset.mimeType && asset.mimeType.toLowerCase() === 'audio/wav');

        // Get the duration of the audio file using expo-av.
        let durationMs = 0;
        try {
          const { sound } = await Audio.Sound.createAsync({ uri });
        const status = await sound.getStatusAsync();
          if (status.isLoaded) {
            durationMs = status.durationMillis || 0;
            console.log(`Picked file duration: ${durationMs}ms`);
          }
        await sound.unloadAsync(); // Unload immediately after getting duration
        } catch (soundError) {
          console.error("Error loading sound to get duration:", soundError);
          // Continue without duration if loading fails
        }

        // Generate placeholder metering data for visual waveform display.
        // This is a rough estimate and not accurate audio data.
        const samplingRate = 60; // Assume 60Hz sampling for metering visual
        const numSamples = Math.ceil((durationMs / 1000) * samplingRate);
        const meteringData = new Array(numSamples).fill(-30); // Default dB value
        console.log(`Created ${numSamples} placeholder metering samples`);

        // --- Extract Raw PCM Data ---
        let rawSamples: Float32Array | null = null;
        let isConverting = false; // Flag to indicate if conversion is needed

        if (isWavFile) {
          // If it's a WAV file, try parsing it directly.
          try {
            console.log('Extracting PCM from WAV file...');
            // Read the file content as base64 for the parser.
            const wavData = await FileSystem.readAsStringAsync(uri, {
              encoding: FileSystem.EncodingType.Base64,
            });
            // Use the custom WAV parser.
            const pcmData = await extractRawPCMFromWAV(wavData) as any; // Cast needed due to JS import
            if (pcmData && pcmData.samples) {
              rawSamples = pcmData.samples;
              console.log(`Extracted ${rawSamples?.length} raw PCM samples from WAV file at ${pcmData.sampleRate}Hz`);
              // TODO: Potentially update options.samplingRate if pcmData.sampleRate is reliable
            } else {
              console.warn('Failed to extract PCM data from WAV: parser returned empty result');
              // Fallback: Could try FFmpeg even for WAV if parser fails
            }
          } catch (error) {
            console.error('Error extracting PCM from WAV file:', error);
            // Fallback: Could try FFmpeg here as well
          }
        } else {
          // If it's not a WAV file, use FFmpeg to decode and extract PCM data.
          isConverting = true; // Set conversion flag for UI feedback
          // Add the file to the list immediately with the converting flag
          setRecordList((prevList) => [{
            uri,
            metering: meteringData,
            rawSamples: null, // No raw samples yet
            duration: durationMs,
            isConverting: true // Indicate conversion process
          }, ...prevList]);
          console.log('Attempting to extract PCM from compressed audio using FFmpeg...');

          // Use try-finally to ensure the converting flag is reset
          try {
            // Call the FFmpeg extraction function (passing the file URI).
            const pcmData = await extractRawPCMFromCompressed(uri) as any; // Cast needed due to JS import
            if (pcmData && pcmData.samples) {
              rawSamples = pcmData.samples;
              console.log(`Generated ${rawSamples?.length} PCM samples from compressed audio using FFmpeg`);
              // Update the existing record list item with the extracted samples
              setRecordList(prevList => prevList.map(item =>
                item.uri === uri ? { ...item, rawSamples: rawSamples, isConverting: false } : item
              ));
            } else {
              throw new Error("FFmpeg extraction returned no samples.");
            }
          } catch (error) {
            console.error('Error extracting PCM from compressed audio using FFmpeg:', error);
            Alert.alert('Processing Error', 'Failed to extract audio data using FFmpeg.');
            // Remove the item or mark it as failed
            setRecordList(prevList => prevList.map(item =>
              item.uri === uri ? { ...item, isConverting: false, rawSamples: null } : item // Keep item but mark as failed
            ));
          }
          // No need for finally block to set isConverting = false, it's handled in the success/error paths above
        }

        // Add to record list ONLY if not converting (WAV case or failed conversion)
        // If converting, the item was already added earlier.
        if (!isConverting) {
        setRecordList((prevList) => [{
          uri,
            metering: meteringData,
            rawSamples: rawSamples, // May be null if extraction failed
            duration: durationMs
        }, ...prevList]);
          console.log('Audio file added to list with PCM data (from WAV parser):', !!rawSamples);
        }
      } else {
        // User cancelled the picker or no assets were returned
        console.log("Document Picker cancelled or returned no assets.");
      }
    } catch (error) {
      console.error('Error picking or processing file:', error);
      Alert.alert('Error', 'Failed to process the selected audio file.');
    }
  }
  
  // --- Render Function ---
  return (
    // Provide the global spectrogram generating state and its setter to children via context
    <AppStateContext.Provider value={{ isSpectrogramGenerating, setIsSpectrogramGenerating }}>
    <View style={styles.container}>
        {/* Show loading indicator if FFmpeg is being loaded initially */}
        {isFFmpegLoading && (
          <View style={styles.ffmpegLoadingContainer}>
            <ActivityIndicator size="large" color="#0000ff" />
            <Text style={styles.ffmpegLoadingText}>Loading audio processing library...</Text>
          </View>
        )}

        {/* List of recorded/imported audio files */}
      <FlatList 
          data={recordList}
          // Render each item using the RecordListItem component
          renderItem={({ item }) => (
            <RecordListItem
              rec={item}
              onSoundLoaded={setActiveSound} // Pass handler to update the active sound
              selectedReplays={selectedReplays} // Pass state for selected items
              setSelectedReplays={setSelectedReplays} // Pass state setter for selected items
              isRecording={isRecording || isSpectrogramGenerating} // Pass combined state to disable during recording or generation
              onDelete={handleDeleteRecording} // Pass the delete handler function
            />
          )}
          keyExtractor={(item) => item.uri} // Use URI as the unique key for each item
        />

        {/* Footer section with playback and action buttons */}
      <View style={styles.footer}>
          {/* Recording Button: Shows 'Record' or 'Stop' based on state */}
          {!isRecording ? (
            // Circular record button when not recording
      <Pressable
              style={[styles.recordButton, { width: 60, borderRadius: 35 }]} // Larger size, circular
              onPress={startRecording} // Start recording on press
              disabled={isFFmpegLoading || isSpectrogramGenerating} // Disable during FFmpeg loading or spectrogram generation
      />
      ) : (
            // Square stop button when recording
      <View style={styles.controlButtons}>
        <Pressable
                style={[styles.recordButton, { width: 50, borderRadius: 5, backgroundColor: 'darkred' }]} // Smaller size, square
                onPress={stopRecording} // Stop recording on press
                disabled={isFFmpegLoading || isSpectrogramGenerating} // Disable during FFmpeg loading or spectrogram generation
        />
              {/* Optionally show a text label */}
              {/* <Button title="Stop" onPress={stopRecording} /> */}
      </View>
      )}

          {/* Other control buttons */}
      <View style={styles.skipButtonsContainer}>
            {/* Skip backward button */}
            <Button 
              title="-1s" 
              onPress={skipBackward} 
              disabled={isRecording || isFFmpegLoading || isSpectrogramGenerating} // Disable during recording, FFmpeg loading, or spectrogram generation
            />
            <Text>  </Text> {/* Spacer */}
            {/* Button to pick an audio file */}
            <Button 
              title="Pick audio" 
              onPress={pickAudioFile} 
              disabled={isRecording || isFFmpegLoading || isSpectrogramGenerating} // Disable during recording, FFmpeg loading, or spectrogram generation
            />
            <Text>  </Text> {/* Spacer */}
            {/* Button to generate a sine wave */}
            <Button 
              title="Sine Wave" 
              onPress={handleSineWaveGeneration} 
              disabled={isRecording || isFFmpegLoading || isSpectrogramGenerating} // Disable during recording, FFmpeg loading, or spectrogram generation
            />
            <Text>  </Text> {/* Spacer */}
            {/* Skip forward button */}
            <Button 
              title="+1s" 
              onPress={skipForward} 
              disabled={isRecording || isFFmpegLoading || isSpectrogramGenerating} // Disable during recording, FFmpeg loading, or spectrogram generation
            />
          </View>
      </View>
      </View>
    </AppStateContext.Provider>
  );
}

// --- Styles ---
const styles = StyleSheet.create({
  container: {
    flex: 1, // Take up all available space
    justifyContent: 'center',
    backgroundColor: '#ecf0f1', // Light background color
  },
  ffmpegLoadingContainer: { // Style for the FFmpeg loading indicator overlay
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.9)', // Semi-transparent white background
    padding: 16,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    zIndex: 1000, // Ensure it's on top
  },
  ffmpegLoadingText: { // Style for the text next to the FFmpeg loader
    marginLeft: 10,
    color: '#0000ff', // Blue text
    fontWeight: '500',
  },
  footer: { // Style for the bottom control bar
    backgroundColor: 'white',
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1, // Add a top border
    borderTopColor: '#ddd', // Light gray border color
  },
  recordButton: { // Style for the record/stop button
    backgroundColor: 'orangered',
    aspectRatio: 1, // Maintain square/circular aspect ratio
    // borderRadius is set dynamically based on isRecording state
    borderWidth: 3,
    borderColor: 'gray', 
    shadowColor: "#000", // Add shadow for depth
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  skipButtonsContainer: { // Container for the row of action buttons
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    // width: '90%', // Adjust width as needed
    marginTop: 10,
  },
  controlButtons: { // Container specifically for the stop button when recording
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center', // Center the stop button
    // gap: 10, // Add spacing if more buttons were here
    marginBottom: 5, // Add some space below the stop button
  },
  header: {
    backgroundColor: 'white',
    padding: 10,
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    padding: 10,
  },
  controlButton: {
    backgroundColor: 'gray',
    padding: 10,
    borderRadius: 5,
  },
  activeButton: {
    backgroundColor: 'green',
  },
  disabledButton: {
    backgroundColor: 'lightgray',
  },
  controlButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: 'white',
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  loadingText: {
    marginTop: 10,
    color: '#0000ff',
    fontWeight: '500',
  },
  recordListContainer: {
    flex: 1,
    padding: 10,
  },
  listTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  recordList: {
    flex: 1,
  },
});

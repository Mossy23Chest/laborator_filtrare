import { View, Text, StyleSheet, Button, TouchableOpacity, Alert, Platform, ActivityIndicator } from 'react-native'
import { FontAwesome5 } from '@expo/vector-icons'
import {useState, useEffect, useContext} from 'react'
import {Audio, AVPlaybackStatus} from 'expo-av'
import {Sound} from 'expo-av/build/Audio'
import Checkbox from 'expo-checkbox';
import { Extrapolation, interpolate } from 'react-native-reanimated'
import { router } from 'expo-router';
import { generateSpectrogram, WindowType, ScaleType, SpectrogramOptions } from '../../utils/spectogram';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
// Import the context created in the parent component (index.tsx)
import { AppStateContext } from '../../app/(tabs)/index';

// Type definition for a sound recording object, matching the one in index.tsx
// (Ideally, this would be shared from a central types file).
export type SoundRecording = {
  uri: string; // Path to the audio file
  metering: number[]; // Simplified amplitude data for visual waveform
  buffer?: Uint8Array; // Not currently used for WAV files
  exactFrequency?: number; // Frequency if it's a generated sine wave
  sineWaveMetering?: boolean; // Deprecated flag
  rawSamples?: Float32Array | null; // Raw PCM audio samples (preferred for analysis)
  duration?: number; // Duration in milliseconds
  isConverting?: boolean; // Flag indicating FFmpeg conversion is in progress
}

// Define the props expected by the RecordListItem component
interface RecordListItemProps {
  rec: SoundRecording; // The recording data object for this list item
  onSoundLoaded: (sound: Sound) => void; // Callback when sound is loaded, passes the sound object up
  selectedReplays: string[]; // Array of URIs of recordings selected for playback
  setSelectedReplays: React.Dispatch<React.SetStateAction<string[]>>; // Function to update the selected replays state
  isRecording: boolean; // Flag indicating if a recording is globally active or spectrogram is generating
  onDelete: (uri: string) => void; // Callback function to trigger deletion in the parent component
}

// React functional component for rendering a single item in the recording list.
const RecordListItem: React.FC<RecordListItemProps> = ({ 
  rec,
  onSoundLoaded,
  selectedReplays,
  setSelectedReplays,
  isRecording, // Destructure the new prop
  onDelete // Destructure the onDelete callback
}) => {

  // State to hold the loaded expo-av Sound object for this item.
  const [sound, setSound] = useState<Sound>();
  // State to hold the current playback status (playing, paused, position, duration, etc.).
  const [status, setStatus] = useState<AVPlaybackStatus>();
  // State to hold default/initial options for spectrogram generation when navigating.
  const [spectrogramOptions, setSpectrogramOptions] = useState<SpectrogramOptions>({
    samplingRate: 44100,
    fftSize: 1024,
    overlap: 0.75,
    windowType: 'hanning',
    scaleType: 'linear',
    minFreq: 0,
    maxFreq: 22050,
    dynamicRange: 50
  });
  // State to indicate if the file is currently being downloaded/saved.
  const [downloadingFile, setDownloadingFile] = useState(false);
  // State to indicate if this item is processing audio for spectrogram navigation.
  const [isProcessing, setIsProcessing] = useState(false);
  // Consume the global spectrogram generating state from the AppStateContext
  // `isSpectrogramGenerating`: true if *any* spectrogram is being generated/navigated to
  // `setIsSpectrogramGenerating`: function to set the global state
  const { isSpectrogramGenerating, setIsSpectrogramGenerating } = useContext(AppStateContext);

  // Effect to reset local processing state when global spectrogram generation finishes
  useEffect(() => {
    if (!isSpectrogramGenerating && isProcessing) {
      console.log(`[RecordListItem ${rec.uri.split('/').pop()}] Global generation finished, resetting local processing state.`);
      setIsProcessing(false);
    }
  }, [isSpectrogramGenerating, isProcessing, rec.uri]); // Watch global state and local state

  // Asynchronously loads the sound from the URI when the component mounts or `rec.uri` changes.
  async function loadSound(){
    console.log('Loading Sound from URI:', rec.uri);
    try {
      // Currently, `rec.buffer` is not used for WAV files saved by the app.
      // This block would handle loading from an in-memory buffer if implemented.
      if (rec.buffer) {
        console.log('Loading in-memory buffer (not typical for saved WAVs)');
        // Convert Uint8Array buffer to base64 data URI.
        const base64Data = btoa(Array.from(rec.buffer).map(byte => String.fromCharCode(byte)).join(''));
        const { sound } = await Audio.Sound.createAsync(
          { uri: `data:audio/wav;base64,${base64Data}` },
          { shouldPlay: false, progressUpdateIntervalMillis: 1000/60 }, // Configure playback updates
          onPlaybackStatusUpdate // Callback function for status updates
        );
        setSound(sound); // Store the loaded sound object in state.
      } else {
        // Load the sound from the file URI.
        const { sound, status: initialStatus } = await Audio.Sound.createAsync(
          { uri: rec.uri },
          { shouldPlay: false, progressUpdateIntervalMillis: 1000/60 }, 
          onPlaybackStatusUpdate 
        );
        setSound(sound); // Store the loaded sound.
        if (initialStatus.isLoaded) {
           setStatus(initialStatus); // Set initial status if loaded successfully.
        }
        console.log(`Sound loaded successfully: ${rec.uri}`);
      }
    } catch (error) {
      console.error('Error loading sound:', error, 'URI:', rec.uri);
      // Check if the error is due to the file not existing (common after deletion/clearing cache)
      if (error instanceof Error && error.message.includes('ENOENT')) {
        Alert.alert('Load Error', `Audio file not found at ${rec.uri}. It might have been deleted.`);
      } else {
        Alert.alert('Load Error', `Failed to load audio from ${rec.uri}`);
      }
      setSound(undefined); // Clear sound state on error
      setStatus(undefined); // Clear status state on error
    }
  }

  // Effect hook to load the sound whenever the `rec` prop changes (specifically `rec.uri`).
  useEffect(() =>{
    // Unload previous sound before loading a new one to free resources.
    if (sound) {
      console.log('Unloading previous sound before loading new one for URI:', rec.uri);
      sound.unloadAsync();
      setSound(undefined); // Clear state immediately
      setStatus(undefined);
    }
    loadSound(); // Load the new sound.
  }, [rec.uri]); // Dependency array: re-run effect only if rec.uri changes.

  // Prepares data and navigates to the SpectrogramScreen.
  // It prioritizes sending raw PCM samples if available, otherwise sends metering data.
  const processAudio = () => {
    console.log("Preparing data for SpectrogramScreen...");

    // --- Pre-Navigation Checks ---
    // 1. Check if a global recording is active.
    if (isRecording) {
      Alert.alert('Recording Active', 'Please stop the current recording before viewing a spectrogram.');
      console.log("Prevented navigation: Global recording active.");
      return;
    }
    // 2. Check if this specific sound is currently playing.
    if (status?.isLoaded && status.isPlaying) {
      Alert.alert('Playback Active', 'Please pause the sound before viewing its spectrogram.');
      console.log("Prevented navigation: Sound is playing.");
      return;
    }
    // 3. Check if already processing or if spectrogram generation is in progress globally.
    if (isProcessing || isSpectrogramGenerating) {
      console.log("Prevented navigation: Already processing or spectrogram generation in progress globally.");
      return;
    }
    // --- End Checks ---

    // Set local state to true, indicating this item is busy preparing for navigation
    setIsProcessing(true); 
    // Set global state to true, indicating the app is busy with spectrogram generation/navigation
    // This will disable interactions on *other* list items via the context
    setIsSpectrogramGenerating(true); 
    let paramsForScreen: any = {}; // Parameters object for navigation.
    let optionsToUse: SpectrogramOptions = { ...spectrogramOptions }; // Start with default spectrogram options.

    try {
      // 1. Check if high-fidelity raw samples exist for this recording.
      if (rec.rawSamples && rec.rawSamples.length > 0) {
        console.log("Found raw samples, passing them.");
        // Stringify the Float32Array to pass as a navigation parameter.
        paramsForScreen.rawSamples = JSON.stringify(Array.from(rec.rawSamples));
        // Calculate duration from raw samples and sample rate.
        let duration = rec.rawSamples.length / (optionsToUse.samplingRate || 44100);
        optionsToUse.duration = duration; // Pass duration in options.
        // Pass exact frequency if it's a known sine wave.
        if(rec.exactFrequency) {
            optionsToUse.sineWaveFrequency = rec.exactFrequency;
        }
        console.log(`Passing raw samples (${rec.rawSamples.length} points) and options:`, optionsToUse);
      
      // 2. Fallback: If no raw samples, use the lower-fidelity metering data.
      } else if (rec.metering && rec.metering.length > 0) {
        console.log("No raw samples found, passing metering data as fallback.");
         // Ensure metering data contains valid numbers, replace invalid ones.
        const validMetering = rec.metering.map(val => 
          (typeof val !== 'number' || isNaN(val) || val === -Infinity) ? -160 : Math.max(-160, Math.min(0, val))
        );
        // Stringify the metering array.
        paramsForScreen.audioMetering = JSON.stringify(validMetering); 
        
        // Estimate duration from various sources (prop, status, metering length).
        const durationFromProp = rec.duration ? rec.duration / 1000 : null;
        const durationFromStatus = status?.isLoaded && status.durationMillis ? status.durationMillis / 1000 : null;
        const durationFromMetering = validMetering.length / 60; // Rough estimate assuming 60Hz metering.
        optionsToUse.duration = durationFromProp ?? durationFromStatus ?? durationFromMetering;
        console.log(`Passing metering (${validMetering.length} points) and options:`, optionsToUse);

      // 3. Error case: No usable data found.
      } else {
        console.error("No raw samples or valid metering data available to pass.");
        Alert.alert('Error', 'Cannot open spectrogram: No valid audio data found for this recording.');
        setIsProcessing(false); // Stop processing indicator on error
        setIsSpectrogramGenerating(false);
        return; // Stop navigation.
      }

      // 4. Navigate to the Spectrogram screen with the prepared data and options.
      console.log("Navigating to SpectrogramScreen with params:", {
          rawSamples: paramsForScreen.rawSamples ? 'Exists' : 'N/A',
          audioMetering: paramsForScreen.audioMetering ? 'Exists' : 'N/A',
          initialOptions: JSON.stringify(optionsToUse) // Stringify options object
      });
      
      // Add onComplete parameter to reset the generating state when navigating back
      paramsForScreen.onComplete = 'true';
      
      router.push({
        pathname: '/(tabs)/spectogramScreen', // Target screen route
        params: { 
          ...paramsForScreen, // Includes either rawSamples OR audioMetering string
          initialOptions: JSON.stringify(optionsToUse) // Pass initial options string
        },
      });
    } catch (error) {
        console.error("Error during audio processing or navigation setup:", error);
        Alert.alert('Navigation Error', 'Could not prepare data for spectrogram screen.');
         // Reset states on error
         setIsProcessing(false); // Still reset local state immediately on error
         setIsSpectrogramGenerating(false);
    }
  };
  
  
  // Callback function invoked by expo-av whenever the playback status updates.
  async function onPlaybackStatusUpdate(newStatus: AVPlaybackStatus){
    setStatus(newStatus); // Update the component's status state.
  
    if(!sound || !newStatus.isLoaded){ // Ignore updates if sound isn't loaded.
      return;
    }

    // If the sound just finished playing:
    if (newStatus.didJustFinish){
      console.log(`Playback finished for: ${rec.uri}`);
      // Reset position to the beginning for potential replay.
      try {
        await sound.setPositionAsync(0);
        // Fetch status again after setting position to update UI correctly.
        const statusAfterReset = await sound.getStatusAsync();
        if (statusAfterReset.isLoaded) {
           setStatus(statusAfterReset);
        }
      } catch (error) {
         console.error("Error resetting sound position:", error);
      }
    }
  }

  // Toggles playback (play/pause) of the sound associated with this list item.
  async function playSound() {  
    if(!sound || !status?.isLoaded){ // Don't play if not loaded.
        console.warn("Attempted to play sound but it's not loaded or has no status.");
        return;
    }
    // // Check if this item is selected in the parent component's state.
    // // This allows for potentially playing multiple selected sounds simultaneously (currently seems unused).
    if (!selectedReplays.includes(rec.uri)) {
      console.log("This recording is not selected. Ignoring play request.");
      return;
    }

    console.log(`Toggling play for: ${rec.uri}, Current status: ${status.isPlaying ? 'playing' : 'paused/stopped'}`); 
    
    try {
      if(status.isPlaying){
        // If currently playing, pause it.
        await sound.pauseAsync();
        console.log(`Paused: ${rec.uri}`);
      } else {
        // If paused or stopped at the beginning/end, play it.
        // `replayAsync` handles starting from beginning if finished.
        // `playAsync` resumes from current position if paused.
        if (status.didJustFinish) {
      await sound.replayAsync();
          console.log(`Replaying: ${rec.uri}`);
        } else {
          await sound.playAsync(); 
          console.log(`Playing/Resuming: ${rec.uri}`);
        }
        onSoundLoaded(sound); // Notify parent component which sound is now active.
      } 
    } catch (error) {
      console.error("Error toggling sound playback:", error);
      Alert.alert("Playback Error", "Could not play or pause the audio.");
    }
  }

  // Effect hook to unload the sound resource when the component unmounts.
  // This is crucial for freeing up native audio resources.
  useEffect(() => {
    return () => { // Cleanup function returned by useEffect.
      if (sound) {
        console.log(`Unloading sound on unmount: ${rec.uri}`);
        sound.unloadAsync(); // Asynchronously unload the sound.
      }
    };
  }, [sound]); // Dependency: run cleanup if `sound` object changes (e.g., becomes undefined).

  // Helper function to format milliseconds into a MM:SS string.
  const millisToSecond = (millis: number | null | undefined): string => {
    if (millis === null || millis === undefined || isNaN(millis) || millis < 0) {
      return '0:00'; // Return default format for invalid input
    }
    const totalSeconds = Math.floor(millis / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`; // Pad seconds with leading zero if needed.
  }

  // Determine playback state and progress from the status object.
  const isPlaying = status?.isLoaded ? status.isPlaying : false;
  const currentPosition = status?.isLoaded ? status.positionMillis : 0; 
  const duration = status?.isLoaded ? status.durationMillis : null; // Use null if duration isn't available.
  // Calculate playback progress (0 to 1), handle zero duration.
  const progress = duration ? currentPosition / duration : 0; 

  // --- Waveform Visualization (Simplified) ---
  // This section generates a simplified visual representation from the metering data.
  // It's not an accurate waveform but gives a basic visual cue.
  let lines: number[] = [];
  let numLines = 35; // Fixed number of vertical lines for the visual.
  if (rec.metering && rec.metering.length > 0) {
    // Downsample or average metering data to fit into `numLines`.
  for (let i = 0; i < numLines; i++){
      const meteringIndex = Math.floor((i * rec.metering.length) / numLines);
      const nextMeteringIndex = Math.ceil(((i+1) * rec.metering.length) / numLines);
      // Ensure slice indices are valid.
      const validMeteringIndex = Math.max(0, meteringIndex);
      const validNextMeteringIndex = Math.min(rec.metering.length, nextMeteringIndex);
      const values = rec.metering.slice(validMeteringIndex, validNextMeteringIndex); 
      // Calculate average dB level for this segment.
      const average = values.length > 0 
        ? values.reduce((sum, a) => sum + (typeof a === 'number' && !isNaN(a) ? a : -160), 0) / values.length 
        : -160; // Default to silence if no valid values.
      lines.push(average); // Store the averaged dB level.
    }
  } else {
    // If no metering data, create flat lines (silence).
    lines = new Array(numLines).fill(-160);
  }
  // --- End Waveform Visualization ---

  // Function to handle downloading/saving the audio file to the device's media library.
  const downloadAudio = async () => {
    if (downloadingFile) return; // Prevent multiple downloads

    try {
      // Request permission to access the media library.
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if ( status !== 'granted') {
        Alert.alert('Permission Denied', 'Cannot save audio without media library permission');
        return;
      }

      setDownloadingFile(true);
      const sourceUri = rec.uri;
      console.log(`Attempting to save audio from URI: ${sourceUri}`);

      // Check if the source URI is valid.
      if (!sourceUri) {
        Alert.alert('Error', 'Invalid audio source URI.');
        setDownloadingFile(false);
        return;
      }

      // Generate a unique filename.
      const timestamp = Date.now();
      let baseFileName = sourceUri.split('/').pop() || `audio-${timestamp}`;
      // Ensure it has a .wav extension if it's known to be WAV or sine wave.
      if (rec.exactFrequency !== undefined || baseFileName.toLowerCase().includes('.wav')) {
          if (!baseFileName.toLowerCase().endsWith('.wav')) {
              baseFileName += '.wav';
          }
      } else {
          // Try to keep original extension or default to .mp3 if unknown
          if (!baseFileName.includes('.')) {
              baseFileName += '.mp3'; // Default fallback extension
          }
      }
      const finalFileName = `exported-${timestamp}-${baseFileName}`;
      const destinationUri = `${FileSystem.cacheDirectory}${finalFileName}`; // Save to cache first.

      console.log(`Target filename: ${finalFileName}, Destination URI: ${destinationUri}`);

      // Handle different source URI types:
      if (sourceUri.startsWith('data:audio/wav;base64,')) {
        // Handle Base64 data URI (likely generated sine waves).
        console.log("Saving from base64 data URI...");
        const base64Data = sourceUri.split('base64,')[1];
        await FileSystem.writeAsStringAsync(
          destinationUri, 
          base64Data,
          { encoding: FileSystem.EncodingType.Base64 }
        );
        console.log("Base64 data written to cache file:", destinationUri);
      } else if (sourceUri.startsWith('file://')) {
        // Handle local file URI.
        console.log("Saving from local file URI by copying...");
        // Check if file exists before copying.
        const fileInfo = await FileSystem.getInfoAsync(sourceUri);
        if (!fileInfo.exists) {
          throw new Error(`Source file does not exist: ${sourceUri}`);
        }
        await FileSystem.copyAsync({
          from: sourceUri,
          to: destinationUri
        });
        console.log("File copied to cache:", destinationUri);
      } else {
        // Handle remote URI (requires download - currently not expected for this app).
        console.log("Saving from remote URI by downloading...");
        const downloadResult = await FileSystem.downloadAsync(sourceUri, destinationUri);
        if (downloadResult.status !== 200) {
          throw new Error(`Failed to download file (status ${downloadResult.status})`);
        }
        console.log("File downloaded to cache:", destinationUri);
      }
      
      // Create an asset in the Media Library from the cached file.
      console.log("Creating asset in Media Library...");
      const asset = await MediaLibrary.createAssetAsync(destinationUri);
      console.log('Asset created:', asset.uri);
      
      Alert.alert('Success', `Audio file saved as ${finalFileName} in your device's media library.`);
      
    } catch (error: any) {
      console.error('Error saving audio file:', error);
      Alert.alert('Error', `Failed to save audio file: ${error.message || 'Unknown error'}`);
    } finally {
      setDownloadingFile(false); // Ensure loading indicator is turned off.
    }
  };

  // Function to handle deleting the audio file and removing the item from the list.
  const handleDelete = () => {
    // Prevent deletion if recording, processing, or generating spectrogram
    if (isRecording || isProcessing || isSpectrogramGenerating || rec.isConverting) {
      console.log("Deletion prevented: Recording/Processing/Generating active.");
      return;
    }

    // Show a confirmation dialog before deleting
    Alert.alert(
      "Delete Recording",
      `Are you sure you want to delete "${rec.uri.split('/').pop()}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            console.log(`Attempting to delete: ${rec.uri}`);
            try {
              // Unload the sound if it's currently loaded for this item
              if (sound) {
                await sound.unloadAsync();
                setSound(undefined);
                setStatus(undefined);
                // Note: We might need a way to signal the parent if this was the *active* sound.
                // For now, we assume the parent handles the activeSound state appropriately.
              }
              // Delete the audio file from the filesystem
              await FileSystem.deleteAsync(rec.uri, { idempotent: true });
              console.log(`File deleted: ${rec.uri}`);
              // Call the onDelete callback passed from the parent (index.tsx)
              // This will trigger the removal of the item from the recordList state.
              onDelete(rec.uri);
            } catch (error) {
              console.error(`Error deleting file ${rec.uri}:`, error);
              Alert.alert("Delete Error", "Could not delete the audio file.");
            }
          },
        },
      ]
    );
  };

  // --- Component Rendering --- 
  return (
    <View style={styles.container}>
      {/* Top section: Filename and Duration/Status */}
      <View style={styles.recordingInfo}>
        {/* Display filename (last part of the URI) */}
        <Text numberOfLines={1} style={styles.filename}>{rec.uri?.split('/').pop() ?? 'Loading...'}</Text>
        
        {/* Display playback position and total duration if available */}
        {status?.isLoaded && (
          <Text style={styles.duration}>
            {millisToSecond(currentPosition)} / {millisToSecond(duration)}
          </Text>
        )}
        
        {/* Show indicator if FFmpeg conversion is happening for this item */}
        {rec.isConverting && (
          <View style={styles.conversionContainer}>
            <ActivityIndicator size="small" color="#0000ff" />
            <Text style={styles.conversionText}>Processing...</Text>
          </View>
        )}
      </View>

      {/* Bottom section: Buttons and Controls */}
      <View style={styles.buttonContainer}>
        {/* Warning icon if raw samples are missing (indicating lower quality for analysis) */}
        {!rec.rawSamples && !rec.isConverting && (
          <FontAwesome5 
            name="exclamation-triangle" 
            size={16} 
            color="#FFA500" // Orange warning color
            style={styles.warningIcon}
          />
        )}

        {/* Checkbox (visual only, state managed by parent) */}
        <Checkbox
          value={selectedReplays.includes(rec.uri)} // Reflect parent state
          onValueChange={() => {
            // Update parent state when checkbox is toggled.
            setSelectedReplays((prevSelected) =>
              prevSelected.includes(rec.uri)
                ? prevSelected.filter((item) => item !== rec.uri) // Remove URI if present.
                : [...prevSelected, rec.uri] // Add URI if not present.
            );
          }}
          color={selectedReplays.includes(rec.uri) ? '#2196F3' : '#888'} // Blue when checked, gray otherwise
          style={styles.checkbox}
          disabled={isProcessing || isRecording || rec.isConverting || isSpectrogramGenerating} // Still disabled by global state too
        />
            
        {/* Play/Pause Button */}
        <TouchableOpacity 
          onPress={playSound} 
          // Disable if: sound not loaded OR converting OR this item is processing OR recording OR any spectrogram is generating
          disabled={!status?.isLoaded || rec.isConverting || isProcessing || isRecording || isSpectrogramGenerating}
        > 
          <FontAwesome5 
            name={isPlaying ? "pause-circle" : "play-circle"}
            size={24} 
            color={!status?.isLoaded || rec.isConverting || isProcessing || isRecording || isSpectrogramGenerating ? '#ccc' : '#333'}
            style={styles.icon}
          />
        </TouchableOpacity>
        
        {/* Spectrogram Button */}
        <TouchableOpacity
          onPress={processAudio}
          // Disable if: converting OR this item is processing OR recording OR any spectrogram is generating
          disabled={rec.isConverting || isProcessing || isRecording || isSpectrogramGenerating} // Disabled by local and global states
        > 
          {/* Use local isProcessing for the indicator, but button is disabled by global state too */} 
          {isProcessing ? (
            <ActivityIndicator size="small" color="#333" style={styles.icon} />
          ) : (
            <FontAwesome5 
              name="chart-bar" 
              size={24} 
              color={rec.isConverting || isProcessing || isRecording || isSpectrogramGenerating ? '#ccc' : (rec.rawSamples ? "#22A7F0" : "#999999")}
              style={styles.icon}
            />
          )}
        </TouchableOpacity>
        
        {/* Download/Save Button */}
        <TouchableOpacity
          onPress={downloadAudio}
          // Disable if: downloading OR converting OR this item is processing OR recording OR any spectrogram is generating OR sound not loaded
          disabled={downloadingFile || rec.isConverting || isProcessing || isRecording || isSpectrogramGenerating || !status?.isLoaded}
        > 
          {downloadingFile ? (
             <ActivityIndicator size="small" color="#333" style={styles.icon} /> 
          ) : (
             <FontAwesome5 
              name="download" 
              size={24} 
              color={downloadingFile || rec.isConverting || isProcessing || isRecording || isSpectrogramGenerating || !status?.isLoaded ? '#ccc' : '#333'} // Corrected color logic
              style={styles.icon}
            />
          )}
        </TouchableOpacity>

        {/* Delete Button */}
        <TouchableOpacity
          onPress={handleDelete}
          // Disable if recording, converting, processing, or spectrogram generating
          disabled={isRecording || rec.isConverting || isProcessing || isSpectrogramGenerating}
        >
          <FontAwesome5 
            name="trash-alt" 
            size={22} // Slightly smaller than other icons
            color={isRecording || rec.isConverting || isProcessing || isSpectrogramGenerating ? '#ccc' : '#dc3545'} // Red color for delete, gray when disabled
            style={styles.icon}
          />
        </TouchableOpacity>
      </View>
    </View>
  )
}

// --- Styles ---
const styles = StyleSheet.create({
    container: {
        backgroundColor: 'white',
        margin: 5,
        padding: 10,
        borderRadius: 10,
        // Shadow for iOS
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.22,
        shadowRadius: 2.22,
        // Elevation for Android
        elevation: 3,
    },
    recordingInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 10,
        width: '100%',
    },
    filename: {
        flex: 1, // Allow filename to take up available space
        color: '#333',
        fontSize: 16,
        fontWeight: '500',
        marginRight: 5, // Add some space before duration
    },
    duration: {
        color: 'gray',
        fontSize: 12,
        marginLeft: 'auto', // Push duration to the right
        paddingLeft: 5, // Space between filename and duration
    },
    buttonContainer: {
      flexDirection: 'row',
      alignItems: 'center',
        justifyContent: 'space-between', // Align buttons
        marginTop: 5,
    },
    checkbox: {
        marginRight: 15, // More space after checkbox
    },
    icon: {
        marginHorizontal: 10, // Space around icons
        padding: 5, // Make icons easier to tap
    },
    warningIcon: {
        marginRight: 8,
        color: '#FFA500', // Ensure color is set here too
    },
    conversionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 10,
    },
    conversionText: {
        color: '#0000ff',
        fontSize: 12,
        marginLeft: 5,
    }
});

export default RecordListItem;
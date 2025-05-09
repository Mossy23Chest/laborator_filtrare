import React, { useState, useMemo, useCallback, useEffect, useRef, useContext } from 'react';
import { View, Text, StyleSheet, ScrollView, Dimensions, Button, Share, TouchableWithoutFeedback, Alert, ActivityIndicator, Platform } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { Svg, Rect, Line, Text as SvgText, Path } from 'react-native-svg';
import { useLocalSearchParams } from 'expo-router';
import { WindowType, SpectrogramOptions, createWindow, ColorMapType, generateSpectrogram } from '../../utils/spectogram';
import Slider from '@react-native-community/slider';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { FFT, dbToLinear } from '../../utils/fft';
import Animated, { useSharedValue, useAnimatedScrollHandler, useDerivedValue } from 'react-native-reanimated';
import { AppStateContext } from './index';
import { applyIIRFilter } from '../../utils/audioFilters';
import myFilterCoefficients from '../../utils/filters/my_iir_filter_coeffs.json';

/**
 * Represents the available color map options for the spectrogram.
 */
type ColorMap = ColorMapType;

/**
 * Fixed height for the spectrogram SVG element for consistency.
 */
const SPECTROGRAM_HEIGHT = 400;

/**
 * Interface defining the structure of the complete spectrogram generation result.
 */

interface SpectrogramResult {
  spectrogram: number[][];
  frequencies: number[];
  times: number[];
  options: SpectrogramOptions;
}


/**
 * Interface defining the data structure for a single frequency spectrum slice
 * calculated for a specific time point.
 */

interface SpectrumData {
  spectrum: number[];
  frequencies: number[];
  maxFreq: number;
}

/**
 * Pre-calculated window function gains used for magnitude correction after FFT.
 * Different window functions attenuate the signal differently, and this corrects for that.
 */
const WINDOW_GAINS: { [key in WindowType]: number } = {
  hanning: 0.5,
  hamming: 0.54,
  blackman: 0.42,
  bartlett: 0.5,
  rectangular: 1.0,
};


/**
 * Shared fixed height for the secondary plot areas displaying the selected time segment's
 * time-domain waveform and frequency spectrum.
 */
const SEGMENT_PLOT_HEIGHT = 150;


/**
 * Maps a magnitude value (in dB) to an RGB color string based on the selected color map and dynamic range.
 * Applies logarithmic scaling to the normalized magnitude for better visual perception of dB differences.
 *
 * @param value The magnitude value (expected to be in dB, defaults to -160 if invalid).
 * @param dynamicRange The dynamic range (dB) to map the colors over. Values below -dynamicRange are clamped.
 * @param colorMap The name of the color map preset to use ('viridis', 'magma', etc.).
 * @returns An RGB color string (e.g., "rgb(255,0,0)").
 */
const getColorFromMagnitude = (value: number, dynamicRange: number, colorMap: ColorMap = 'viridis') => {
  // Ensure magnitude is a valid number in dB scale, defaulting to a very low value.
  const dbValue = typeof value === 'number' ? value : -160;

  // Normalize the dB value to the range [0, 1] based on the dynamic range.
  // Values below -dynamicRange are clamped to 0, values above 0 dB are clamped to 1.
  const normalizedValue = Math.min(1.0, Math.max(0.0, (dbValue + dynamicRange) / dynamicRange));

  // Apply logarithmic scaling to the normalized value.
  // This enhances the visibility of lower magnitude details which are often perceptually important.
  // `Math.log1p(x)` is equivalent to `log(1 + x)`, avoiding issues near log(0).
  // The multiplication by 9 and division by log1p(10) scales the result back approximately to the [0, 1] range.
  const epsilon = 1e-6; // Small value to avoid log(0)
  const logScaledValue = Math.log1p(normalizedValue * 9 + epsilon) / Math.log1p(10); // Scale normalizedValue to roughly [0, 1] logarithmically
  const adjustedValue = Math.min(1.0, Math.max(0.0, logScaledValue)); // Re-clamp after log scaling

  // Select the color based on the chosen color map and the log-scaled adjusted value.
  // Each case implements a specific color gradient mapping from 0 (low magnitude) to 1 (high magnitude).
  switch (colorMap) {
    case 'viridis':
      // Viridis color map (perceptually uniform)
      // Coefficients approximate the viridis gradient.
      const r_val = (0.267004 + adjustedValue * 0.731859);
      const g_val = (0.004874 + adjustedValue * 0.829359);
      const b_val = (0.329415 + adjustedValue * (-0.144721));

      return `rgb(${Math.floor(255 * Math.max(0, Math.min(1, r_val)))},${Math.floor(255 * Math.max(0, Math.min(1, g_val)))},${Math.floor(255 * Math.max(0, Math.min(1, b_val)))})`;
    
    case 'magma':
      // Magma color map (perceptually uniform)
      // Coefficients approximate the magma gradient.
      return `rgb(${Math.floor(255 * (0.001462 + normalizedValue * 0.998538))},${Math.floor(255 * (0.000466 + normalizedValue * 0.533354))},${Math.floor(255 * (0.013866 + normalizedValue * 0.786254))})`;
    
    case 'plasma':
      // Plasma color map (perceptually uniform)
      // Coefficients approximate the plasma gradient.
      return `rgb(${Math.floor(255 * (0.050383 + adjustedValue * 0.949617))},${Math.floor(255 * (0.029803 + adjustedValue * 0.970197))},${Math.floor(255 * (0.527975 + adjustedValue * (-0.527975)))})`;
    
    case 'inferno':
      // Inferno color map - using square root based interpolation
      const x_inf = adjustedValue;
      const r_inf = Math.sqrt(x_inf * (0.9896 - x_inf * (2.348 - x_inf * 1.358)));
      const g_inf = Math.sqrt(x_inf * (0.3267 - x_inf * (0.1169 + x_inf * 0.4194)));
      const b_inf = Math.sqrt(x_inf * (0.01587 + x_inf * (0.7095 - x_inf * (1.225 - x_inf * 0.498))));
      return `rgb(${Math.floor(255 * r_inf)}, ${Math.floor(255 * g_inf)}, ${Math.floor(255 * b_inf)})`;
    
    case 'grayscale':
      // Simple grayscale mapping (using the original normalized value for linear intensity)
      const intensity = Math.floor(255 * normalizedValue);
      return `rgb(${intensity},${intensity},${intensity})`;
    
    default:
      // Fallback to black if color map is unknown
      return 'rgb(0,0,0)';

  }
};

/**
 * Generates an array of "nice" tick values for a Y-axis (typically frequency or magnitude).
 * Aims to produce evenly spaced ticks at reasonable intervals based on the maximum value.
 *
 * @param maxVal The maximum value on the axis.
 * @returns An array of numerical tick values.
 */
const getYAxisTicks = (maxVal: number): number[] => {
  if (maxVal <= 0) return [0]; // Handle zero or negative max

  // Determine a suitable step size between ticks based on the magnitude of maxVal.
  let tickStep: number;
  if (maxVal <= 1) tickStep = 0.2;
  else if (maxVal <= 5) tickStep = 1;
  else if (maxVal <= 10) tickStep = 2;
  else if (maxVal <= 50) tickStep = 10;
  else if (maxVal <= 100) tickStep = 20;
  else if (maxVal <= 250) tickStep = 50;
  else if (maxVal <= 500) tickStep = 100;
  else if (maxVal <= 1000) tickStep = 200;
  else tickStep = Math.pow(10, Math.floor(Math.log10(maxVal))) / 2; // Generic step for larger values

  // Calculate the ceiling rounded to the nearest tickStep.
  const roundedMax = Math.ceil(maxVal / tickStep) * tickStep;
  // Determine the number of ticks needed to reach the rounded maximum.
  const numTicks = Math.max(2, Math.round(roundedMax / tickStep) + 1);
  // Generate the array of tick values.
  let ticks = Array.from({ length: numTicks }, (_, i) => i * tickStep);

  // Ensure the exact maximum value is included if it's not already close to the last tick.
  // This is important for correctly labeling the top of the axis.
  if (ticks[ticks.length - 1] < maxVal) {
    ticks.push(maxVal);
  }

  return ticks;
};

/**
 * Generates an array of "nice" tick values for a time axis (X-axis).
 * Selects appropriate time steps (e.g., 0.1s, 0.5s, 1s) based on the total duration.
 *
 * @param duration The total duration of the audio signal in seconds.
 * @returns An array of numerical time tick values (in seconds).
 */

const generateTimeTicks = (duration: number): number[] => {
  if (duration <= 0) return [0]; // Handle zero or negative duration

  // Determine a suitable time step based on the total duration.
  let timeStep: number;
  if (duration <= 0.5) timeStep = 0.1;
  else if (duration <= 1) timeStep = 0.2;
  else if (duration <= 3) timeStep = 0.5;
  else if (duration <= 10) timeStep = 1.0;
  else timeStep = Math.ceil(duration / 10); // Aim for roughly 10 ticks for longer durations

  // Calculate the number of ticks based on the chosen step.
  const numTicks = Math.floor(duration / timeStep) + 1;

  // Generate the array of tick values, ensuring they don't exceed the duration.
  let ticks = Array.from({ length: numTicks }, (_, i) => Math.min(i * timeStep, duration));

  // Ensure the exact total duration is included as the last tick if it's not already present.
  // Crucial for labeling the end of the time axis correctly.
  if (ticks[ticks.length - 1] < duration) {
    ticks.push(duration);
  }

  return ticks;
};


/**
 * SpectrogramScreen Component
 *
 * This screen displays a spectrogram visualization of an audio signal.
 * It receives audio data (either raw samples or metering info) and initial options
 * via navigation parameters. It allows users to view the spectrogram, interact with it
 * (in rotated view), adjust visualization parameters (color map, dynamic range),
 * view time/frequency domain plots of selected segments, and export basic data.
 */
const SpectrogramScreen: React.FC = () => {
  // Import the global spectrogram generating state
  const { isSpectrogramGenerating, setIsSpectrogramGenerating } = useContext(AppStateContext);
  
  // --- Hooks ---
  // Get navigation parameters passed from the previous screen.
  const {
    audioMetering: audioMeteringString, // Fallback low-fidelity audio data (JSON string)
    initialOptions, // Spectrogram generation options (JSON string)
    rawSamples: rawSamplesString,       // Preferred high-fidelity raw PCM samples (JSON string)
    uri                           // Original URI of the audio file (used for cache keying)
  } = useLocalSearchParams<{
    audioMetering: string;        // Expecting stringified array
    initialOptions: string;       // Expecting stringified SpectrogramOptions
    rawSamples?: string;          // Optional: Expecting stringified Float32Array
    uri?: string;                 // Optional: Original file URI
  }>();
  
  // Hook to check if the screen is currently focused (visible to the user).
  // Used to trigger data generation only when visible and for cleanup on blur.
  const isFocused = useIsFocused();

  // --- State Variables ---
  const windowWidth = Dimensions.get('window').width; // Device window width for layout calculations.
  const [showControls, setShowControls] = useState(false); // Controls visibility of the settings panel (color map, FFT size, etc.).
  const [colorMap, setColorMap] = useState<ColorMap>('viridis'); // Currently selected color map preset for the spectrogram visualization.
  const [isRotated, setIsRotated] = useState(false); // Toggles between standard horizontal spectrogram and rotated vertical view.
  const [selectedTimeIndex, setSelectedTimeIndex] = useState<number | null>(null); // Index of the currently selected time frame (column in the spectrogram matrix).
  const [isFilterEnabled, setIsFilterEnabled] = useState(false); // State to toggle IIR filter

  // State for the visual selection indicator (line/rectangle) on the spectrogram.
  // In rotated view, this is a horizontal line at the selected time.
  const [selectionRect, setSelectionRect] = useState<{ x: number; y?: number; width: number; height?: number; visible: boolean }>({ x: 0, width: 0, visible: false });
  const [selectedTime, setSelectedTime] = useState<string | null>(null);  // Formatted string representation of the selected time value (e.g., "1.234s").
  const [spectrumData, setSpectrumData] = useState<SpectrumData | null>(null); // Holds the calculated frequency spectrum data for the currently selected time slice.

  const [isLoading, setIsLoading] = useState(false); // Indicates if the main spectrogram generation process is running.
  const [spectrogramResult, setSpectrogramResult] = useState<SpectrogramResult | null>(null);  // Stores the complete result of the spectrogram generation (data + options used).

  // --- Default and Initial Options ---
  // Default spectrogram generation options used if none are provided or parsing fails.
  const defaultOptions: SpectrogramOptions = {
    samplingRate: 44100, // Standard quality sample rate
    fftSize: 1024, // Common FFT size, balances time/frequency resolution
    overlap: 0.75, // High overlap for smoother spectrogram appearance
    windowType: 'hanning', // Hanning window is a good general-purpose choice
    scaleType: 'linear', // Frequency scale (linear or mel) - Currently only linear used for display
    minFreq: 0,  // Minimum frequency to display
    maxFreq: 22050, // Maximum frequency (Nyquist for 44.1kHz)
    dynamicRange: 50, // Default dynamic range for color mapping (dB)
    colorMap: 'viridis',  // Default color map
  };


  // State holding the *current* spectrogram options, initialized from passed params or defaults.
  // These options can be modified by user controls (FFT size, overlap, window, dyn range).
  const [options, setOptions] = useState<SpectrogramOptions>(() => {
    if (initialOptions) {
      try {
        // Parse options passed via navigation.
        const parsed = JSON.parse(initialOptions);
        // Merge with defaults to ensure all necessary keys are present.
        return { ...defaultOptions, ...parsed };
      } catch (e) {
        console.error('Error parsing initial options:', e);
      }
    }
    // Fallback to defaults if parsing fails or no options were passed.
    return defaultOptions;
  });

  // --- Data Parsing ---
  // Memoized parsing of the raw PCM samples string passed via navigation.
  // This avoids re-parsing on every render unless the input string changes.
  const rawSamples = useMemo<Float32Array | null>(() => {
    if (rawSamplesString) {
      try {
        // Parse the JSON string back into an array.
        const parsedArray = JSON.parse(rawSamplesString);
        console.log(`Parsed ${parsedArray.length} raw samples successfully.`);
        // Convert the array into a Float32Array for numerical operations.
        return new Float32Array(parsedArray);
      } catch (e) {
        console.error("Error parsing raw samples:", e);
      }
    }
    return null; // Return null if no string was provided or parsing failed.
  }, [rawSamplesString]); // Dependency: Only re-run if the input string changes.

  // Apply the IIR filter to the raw samples
  const filteredSamples = useMemo<Float32Array | null>(() => {
    if (!rawSamples) {
      return null; // No raw samples to process
    }
    // If the filter is enabled and filter coefficients are available,
    // apply the IIR filter using the 'applyIIRFilter' utility function.
    // The coefficients are imported from a JSON file (my_iir_filter_coeffs.json).
    if (isFilterEnabled && myFilterCoefficients.b && myFilterCoefficients.a) {
      console.log("Applying IIR filter to audio samples...");
      const startTime = performance.now(); // Optional: for performance measurement
      
      const processedSamples = applyIIRFilter(rawSamples, myFilterCoefficients.b, myFilterCoefficients.a);
      
      const endTime = performance.now();
      console.log(`IIR filtering took ${(endTime - startTime).toFixed(2)} ms for ${rawSamples.length} samples.`);
      return processedSamples;
    }
    // If filter is not enabled or coefficients are missing, return raw samples
    // This ensures that the 'filteredSamples' variable always holds valid audio data
    // (either processed or original) for subsequent steps like spectrogram generation.
    console.log("IIR Filter is OFF or coefficients missing, using raw samples.");
    return rawSamples; 
  }, [rawSamples, isFilterEnabled]);

  // --- Spectrogram Generation Effect ---
  // This effect handles triggering the `generateSpectrogram` utility function
  // when the screen becomes focused or relevant input props/options change.
  useEffect(() => {
    console.log(`[Generation Effect] Running. Focused: ${isFocused}, URI: ${uri}, Result Exists: ${!!spectrogramResult}, IsLoading: ${isLoading}, Filter: ${isFilterEnabled}`);

    // --- Conditions to SKIP generation ---
    // 1. Screen not focused: Don't generate if the user isn't viewing the screen.
    if (!isFocused) {
      console.log("[Generation Effect Skip] Screen is not focused.");
      return;
    }

    // 2. No input data: If neither raw samples nor metering data is available.
    if (!audioMeteringString && !rawSamplesString) {
      console.warn('[Generation Effect] No audio input props.');
      // Clear previous results if input disappears.
      if (spectrogramResult) setSpectrogramResult(null);
      return;
    }

    // 3. Already have results or currently loading: Avoid redundant generation.
    // Generate only if `spectrogramResult` is null AND `isLoading` is false.
    if (spectrogramResult !== null || isLoading) {
      console.log(`[Generation Effect Skip] Result Exists: ${!!spectrogramResult}, IsLoading: ${isLoading}`);
      return;
    }

    // --- End Skip Conditions ---

    // --- Proceed with Generation ---

    console.log("[Generation Effect] Conditions met, proceeding with generation...");

    // Reset visualization options (like color map, dynamic range) to the initial/default values
    // before starting a new generation, as the underlying data is changing.
    console.log("[Generation Effect] Resetting controls (colorMap, options) to defaults.");
    setColorMap(defaultOptions.colorMap || 'viridis'); // Use initial/default
    setOptions(prev => ({
      ...prev, // Keep existing sampleRate, duration etc.
      // Reset options controllable by the user interface:
      windowType: defaultOptions.windowType || 'hanning',
      fftSize: defaultOptions.fftSize || 1024,
      overlap: defaultOptions.overlap !== undefined ? defaultOptions.overlap : 0.75,
      dynamicRange: defaultOptions.dynamicRange || 50
    }));

    // Prepare audio input data for the generator function.
    let audioInputData: Float32Array | number[] | null = null;
    let estimatedDuration = 0;
    const currentSamplingRate = options.samplingRate || 44100;

    if (isFilterEnabled && filteredSamples && filteredSamples.length > 0) {
      console.log("[Generation Effect] Using FILTERED samples as input.");
      audioInputData = filteredSamples;
      estimatedDuration = filteredSamples.length / currentSamplingRate;
    } else if (rawSamples && rawSamples.length > 0) { 
      console.log("[Generation Effect] Filter OFF or filtered samples unavailable. Using RAW samples as input.");
      audioInputData = rawSamples;
      estimatedDuration = rawSamples.length / currentSamplingRate;
    } else if (audioMeteringString) {
      console.log("[Generation Effect] Using audioMeteringString prop as input.");
      try {
        const parsedMetering = JSON.parse(audioMeteringString);
        if (parsedMetering && Array.isArray(parsedMetering.spectrogram)) { // Old format check
          console.warn("[Generation Effect] Received old SpectrogramData structure - cannot generate.");
          Alert.alert("Warning", "Cannot regenerate spectrogram from this old data format.");
        } else if (Array.isArray(parsedMetering)) {
          audioInputData = parsedMetering.map((val: any) => 
            (typeof val !== 'number' || isNaN(val) || val === -Infinity) ? -160 : Math.max(-160, Math.min(0, val))
          );
          estimatedDuration = options.duration || (parsedMetering.length / 60);  // Use existing options.duration or estimate
        } else {
          throw new Error("Invalid audioMeteringString format");
        }
  } catch (error) {
        console.error('[Generation Effect] Error parsing audioMeteringString:', error);
        Alert.alert('Error', 'Could not parse audio metering data.');
        setIsLoading(false); // Stop loading if parsing fails
        return;
      }
    } else {
      console.warn('[Generation Effect] No audio input props available after attempting all sources.');
      if (spectrogramResult) setSpectrogramResult(null);
      setIsLoading(false); // Stop loading if no input
      return;
    }

    // Final check if audio data preparation failed.
    if (!audioInputData || audioInputData.length === 0) {
      console.error("[Generation Effect] Failed to prepare audio input data for generator or data is empty.");
      setIsLoading(false); // Stop loading if data prep fails
      return;
    }

    // --- Start Asynchronous Generation ---
    console.log("[Generation Effect] Setting loading state.");
    setIsLoading(true);

    // Create a copy of options to pass to the generator function, ensuring duration is updated.
    const generationOptions = { 
      ...options,
      duration: estimatedDuration // Pass the accurately calculated duration
    };
    const inputDataForGenerator = audioInputData; // Use the prepared data

    console.log("[Generation Effect] Starting generateSpectrogram call with duration:", estimatedDuration);
    generateSpectrogram(inputDataForGenerator, generationOptions)
      .then((result: SpectrogramResult) => {
        // --- Success ---
        console.log(`[Generation Effect] Generation complete. Frames: ${result.spectrogram.length}`);
        setSpectrogramResult(result);   // Store the complete result in state
      })
      .catch(error => {
        // --- Failure ---
        console.error("[Generation Effect] Error during spectrogram generation:", error);
        Alert.alert("Generation Error", `Failed to generate spectrogram: ${error.message}`);
        setSpectrogramResult(null); // Clear result on error
      })
      .finally(() => {
        // --- Cleanup (runs on success or failure) ---
        setIsLoading(false); // Reset loading state.
        console.log("[Generation Effect] Generation process finished (finally block).");
      });


    // --- Dependency Array ---
    // Re-run this effect if:
    // - The screen focus state changes (`isFocused`).
    // - The input data strings change (`uri`, `rawSamplesString`, `audioMeteringString`).
    // - Critical generation parameters change (`fftSize`, `overlap`, `windowType`, `samplingRate`).
    // - The `spectrogramResult` or `isLoading` state changes (used to prevent re-runs while loading or if result exists).
  }, [
    uri,
    rawSamples, // Using the parsed rawSamples directly
    filteredSamples, // Added dependency
    isFilterEnabled, // Added dependency
    audioMeteringString, // Still needed as a fallback
    options.fftSize,
    options.overlap,
    options.windowType,
    options.samplingRate, // Keep options.samplingRate as options.duration depends on it here
    // options.duration is now calculated inside, so it should not be a direct dependency if it causes loops.
    // However, if user can change options.duration via controls and expect re-gen, it might be needed.
    // For now, relying on options object changes or specific sub-properties that influence generation.
    // Let's keep the existing specific option dependencies and add the new sample ones.
    spectrogramResult,  // Re-run if result becomes null (e.g., after blurring)
    isLoading,  // Re-run if loading finishes
    isFocused // Re-run when focus changes
  ]);

  // --- Focus Effect for Cleanup ---
  // This effect runs when the screen gains focus and returns a cleanup function
  // that runs when the screen loses focus (blurs).
  useFocusEffect(
    useCallback(() => {
      // Action on focus (currently none needed here).
      return () => {
        // Cleanup action on blur:
        console.log("[FocusEffect Cleanup] Spectrogram screen blurred, clearing interaction and result state.");
        // Reset interaction states.
        setSpectrumData(null);
        setSelectedTimeIndex(null);
        setSelectionRect({ x: 0, width: 0, visible: false });
        setSelectedTime(null);
        setIsLoading(false); // Ensure loading is stopped if navigating away during a load.
        setSpectrogramResult(null);  // Crucially, clear the main spectrogram result to force regeneration on next focus.
        
        // Reset the global generating state when unmounting
        setIsSpectrogramGenerating(false);
      };
    }, [setIsSpectrogramGenerating]) // Add setIsSpectrogramGenerating to the dependencies
  );

  // Also reset the global state when spectrogram generation completes
  useEffect(() => {
    if (!isLoading && spectrogramResult) {
      // Reset the global generating state when spectrogram is loaded
      setIsSpectrogramGenerating(false);
    }
  }, [isLoading, spectrogramResult, setIsSpectrogramGenerating]);

  // --- Layout Constants and Calculations ---
  // Define padding values for the SVG plot areas.
  const plotHeight = Math.min(windowWidth - 60, 400); // Consistent plot height
  const svgPaddingLeft = 55; // Space for Y-axis labels (Frequency or Time)
  const svgPaddingTop = 20;  // Space above the plot area
  const svgPaddingBottom = 40; // Space below for X-axis labels (Time or Frequency)
  const svgPaddingRight = 15; // Space to the right of the plot area

  // Calculate the available width for the plot content within the screen and padding.
  const availableWidth = windowWidth - svgPaddingLeft - svgPaddingRight;

  // Calculate dimensions for both rotated and non-rotated views for consistency.
  // Use a fixed aspect ratio for the *rotated* view's plot area (width relative to height).
  const rotatedAspectRatio = 1 / 0.7; // Example: Width is ~1.4x the height in rotated view
  const rotatedPlotWidth = plotHeight * rotatedAspectRatio;  // Calculate width based on height and aspect ratio

  const nonRotatedPlotWidth = rotatedPlotWidth; // Make the non-rotated plot width match the rotated width for a visually consistent length.
  const nonRotatedPlotHeight = plotHeight; // Use the consistent plot height

  console.log(`Layout - Plot H: ${plotHeight}, Rotated W: ${rotatedPlotWidth.toFixed(0)}, Non-Rotated W: ${nonRotatedPlotWidth.toFixed(0)}`);


  // --- Downsampling Logic for Rendering Performance ---
  // Calculate downsampling factors to reduce the number of SVG elements (Rects) rendered,
  // especially for long recordings or high FFT sizes, preventing performance issues.
  const currentFrames = spectrogramResult?.spectrogram.length || 0; // Number of time frames
  const currentFreqs = spectrogramResult?.frequencies?.length ?? 0;  // Number of frequency bins
  const currentDuration = spectrogramResult?.options?.duration ?? 0; // Duration from result options
  const MAX_RECTANGLES = 7500; // Target maximum number of SVG Rect elements to render
  const totalPoints = currentFrames * currentFreqs; // Total potential data points

  // Calculate a base downsampling factor needed to stay below the max rectangles limit.
  const baseDownsampleFactor = Math.max(1, Math.ceil(totalPoints / MAX_RECTANGLES));

  // Distribute the downsampling between time and frequency dimensions (using sqrt).
  // This tries to maintain the aspect ratio visually.
  let finalTimeDownsample = Math.max(1, Math.floor(Math.sqrt(baseDownsampleFactor)));
  let finalFreqDownsample = Math.max(1, Math.floor(Math.sqrt(baseDownsampleFactor)));

  // Disable downsampling for very short signals where detail is important.
  if (currentDuration > 0 && currentDuration < 1) {
    finalTimeDownsample = 1;
    finalFreqDownsample = 1;
  }
  console.log(`[Downsampling] Total Points: ${totalPoints}, Base Factor: ${baseDownsampleFactor}, Time Factor: ${finalTimeDownsample}, Freq Factor: ${finalFreqDownsample}`);
  // --- End Downsampling Logic ---

  // --- Pixel Step Calculation (for rendering rectangles) ---
  // Calculate the width and height of each downsampled rectangle in pixels.
  const effectiveTimePointsFinal = Math.ceil(currentFrames / finalTimeDownsample); // Number of time points after downsampling
  const xPixelStepFinal = nonRotatedPlotWidth > 0 && effectiveTimePointsFinal > 0 ?
    nonRotatedPlotWidth / effectiveTimePointsFinal : 1;  // Width of each rect in non-rotated view
  const effectiveFreqPointsFinal = Math.ceil((spectrogramResult?.frequencies.length || 1) / finalFreqDownsample);  // Number of freq points after downsampling
  const yPixelStepFinal = nonRotatedPlotHeight > 0 && effectiveFreqPointsFinal > 0 ?
    nonRotatedPlotHeight / effectiveFreqPointsFinal : 1;  // Height of each rect in non-rotated view
  // --- End Pixel Step Calculation ---

  // --- Shared Value for Scroll Position (React Native Reanimated) ---
  // Used for optimizing rendering in the horizontally scrolling non-rotated view.
  const scrollX = useSharedValue(0);

  // --- Scroll Handler ---
  // Updates the `scrollX` shared value when the horizontal ScrollView is scrolled.
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
  });

  /**
   * Handles the "Export Data" button press.
   * Creates a simple text file summarizing the spectrogram options and a small sample
   * of the data, then uses the native Share API to let the user save or send it.
  */
  const handleExport = async () => {
    // Prevent export if data is still loading or not available.
    if (isLoading) {
      Alert.alert("Export Unavailable", "Please wait for spectrogram generation to complete before exporting.");
      return;
    }
    if (!spectrogramResult) { // Check if result exists
      Alert.alert("Export Unavailable", "No spectrogram data available to export.");
      return;
    }
    try {
      console.log("Exporting spectrogram data as txt file...");
      // Format the options used for this spectrogram.
      const optionsText = Object.entries(spectrogramResult.options)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
      // Create a small preview of the spectrogram data (first 10 frames, first 5 bins).  
      const dataPreview = spectrogramResult.spectrogram // Use full data from result
        .slice(0, 10) // Limit rows
        .map((row: number[]) => row.slice(0, 5).map((v: number) => v.toFixed(2)).join(', ')) // Limit columns, format numbers
        .join('\n');
      // Combine options, preview, and metadata into the file content.
      const fileContent = 
        `Spectrogram Data\n\nOptions:\n${optionsText}\n\nData Sample (first 10 frames):\n${dataPreview}\n\nTotal frames: ${spectrogramResult.spectrogram.length}\nFrequencies: ${spectrogramResult.frequencies.length}\nTime points: ${spectrogramResult.times.length}`;
      // Create a unique filename using a timestamp.
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `spectrogram_data_${timestamp}.txt`;
      // Define the file path in the app's cache directory.
      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      // Write the content to the text file.
      await FileSystem.writeAsStringAsync(fileUri, fileContent);
      console.log("File written to:", fileUri);
      // Use the appropriate sharing mechanism based on the platform.
      if (Platform.OS === 'android') {
        // Use Expo Sharing module for Android intents.
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri);
        } else {
          console.error("Sharing not available on this device.");
          Alert.alert("Sharing Error", "Sharing is not available on this device.");
        }
      } else {
        // Use React Native Share API for iOS share sheet.
        await Share.share({
          url: fileUri, // Pass file URI for iOS
          title: 'Spectrogram Data', // Optional title
        });
      }
    } catch (error: any) {
      console.error("Error exporting data:", error);
      Alert.alert("Export Error", `Failed to export data: ${error.message}`);
    }
  };

  // --- Derived Data and Memoized Calculations ---
  // Get the current options, frequencies, and times from the spectrogram result,
  // falling back to the state options if the result isn't available yet.
  const currentOptions = spectrogramResult?.options ?? options; // Use options from result if available
  const currentFrequencies = spectrogramResult?.frequencies ?? [];
  const currentTimes = spectrogramResult?.times ?? [];

  // Memoize the calculation of axis ticks (frequency and time).
  // This prevents recalculating ticks on every render unless relevant options change.
  const { freqTicks, timeTicks } = useMemo(() => {
    // Determine the maximum frequency to plot based on options.
    const freqMax = currentOptions.maxFreq || ((currentOptions.samplingRate || 44100) / 2);
    // Generate frequency ticks (for the y axis) using the helper function.
    const ticks = getYAxisTicks(freqMax);

    // Ensure freqMax is represented exactly for highest tick (most important)
    const lastTick = ticks[ticks.length - 1];
    if (Math.abs(lastTick - freqMax) > 0.01 * freqMax) {
      // The current ticks don't include a value very close to freqMax
      ticks.push(freqMax);
    }

    // Determine the duration to plot based on options.
    const duration = (currentOptions.duration || 0);
    // Generate time ticks (for the x axis) using the helper function.
    const timeTickValues = generateTimeTicks(duration);

    // Ensure the exact duration is included, which is critical for labeling
    const lastTimeTick = timeTickValues[timeTickValues.length - 1];
    if (duration > 0 && Math.abs(lastTimeTick - duration) > 0.01 * duration) {
      // The current time ticks don't include a value very close to duration
      timeTickValues.push(duration);
    }

    console.log(`Generated ${ticks.length} frequency ticks: ${ticks.join(', ')}`);
    console.log(`Generated ${timeTickValues.length} time ticks: ${timeTickValues.join(', ')}`);

    return { freqTicks: ticks, timeTicks: timeTickValues };
  }, [currentOptions.maxFreq, currentOptions.minFreq, currentOptions.duration, currentOptions.samplingRate]);

  // Memoize the calculation of the actual last time value present in the results.
  // This is used for accurate scaling of the time axis in the non-rotated view.
  const actualLastTime = useMemo(() => {
    if (!spectrogramResult?.times || spectrogramResult.times.length === 0) return 0;
    // Get the time value of the very last frame.
    return spectrogramResult.times[spectrogramResult.times.length - 1];
  }, [spectrogramResult?.times]); // Dependency: recalculate if the times array changes

  // Pre-calculate X-positions for time points in the non-rotated view.
  // Accounts for time downsampling. Only calculates positions for the points that will be rendered.
  const timePositions = useMemo(() => {
    // Number of time points after downsampling.
    const effectivePoints = Math.ceil(currentTimes.length / finalTimeDownsample || 0);
    // Calculate the horizontal step between each downsampled time point.
    const step = nonRotatedPlotWidth > 0 && effectivePoints > 0 ? nonRotatedPlotWidth / effectivePoints : 1;
    // Return an array mapping downsampled index to pixel X-position and original time index.
    return Array.from({ length: effectivePoints }, (_, timeIdx) => {
      const originalTimeIdx = timeIdx * finalTimeDownsample;
      return {
        x: timeIdx * step, // Pixel X position for this downsampled point
        timeIndex: originalTimeIdx, // Original index in the `currentTimes` array
      };
    });
  }, [currentTimes.length, finalTimeDownsample, nonRotatedPlotWidth]);


  /**
  * Calculates the frequency spectrum for a specific time slice index.
  * Extracts the corresponding segment of raw audio samples (if available),
  * applies windowing, performs FFT, corrects for window gain, and updates
  * the `spectrumData` state for rendering the secondary spectrum plot.
  *
  * @param timeIndex The index of the time frame in the `spectrogramResult.times` array.
  */

  const calculateTimeSliceSpectrum = useCallback((timeIndex: number) => {
    // Get the timestamp for this slice and update the display stat
    const timeStamp = currentTimes && currentTimes[timeIndex] ? currentTimes[timeIndex].toFixed(3) : timeIndex.toString();
    setSelectedTime(timeStamp);
    
    console.log(`Processing time segment around index ${timeIndex}, time ${timeStamp}s`);
    
    let samplesForSegment: Float32Array;

    // --- Extract Audio Segment ---
    // 1. Prioritize using filtered PCM samples for highest accuracy.
    if (filteredSamples) {
      console.log("Using filtered samples for time slice spectrum");
      // Estimate the number of audio samples corresponding to one time frame in the spectrogram.
      // This depends on the original audio length and the number of time frames generated.
      const samplesPerTimeFrame = (currentTimes && currentTimes.length > 0 && filteredSamples) ? Math.floor(filteredSamples.length / currentTimes.length) : (currentOptions.samplingRate || 44100) * 0.01; // Fallback to 10ms worth of samples
      // Calculate the starting sample index in the raw audio array.
      const startSampleIndex = timeIndex * samplesPerTimeFrame;
      // Define the length of the segment to analyze (typically the FFT size).
      const segmentLength = currentOptions.fftSize || 1024;
      // Calculate the ending sample index, clamping to the array bounds.
      const endSampleIndex = filteredSamples ? Math.min(startSampleIndex + segmentLength, filteredSamples.length) : startSampleIndex + segmentLength;

      // Extract the slice of raw samples.
      samplesForSegment = filteredSamples ? filteredSamples.slice(startSampleIndex, endSampleIndex) : new Float32Array();
      console.log(`Extracted ${samplesForSegment.length} filtered samples from index ${startSampleIndex} to ${endSampleIndex}`);

    } else {
      // 2. Fallback: Reconstruct an approximate signal from spectrogram data (less accurate).
      // This is generally not ideal but provides a fallback if raw samples were lost or not provided.
      console.warn("Raw samples not available, reconstructing from spectrogram for time slice spectrum");
      if (!spectrogramResult?.spectrogram || !spectrogramResult.spectrogram[timeIndex]) {
        console.error("No spectrogram data available for timeIndex:", timeIndex);
        return;
      }
      // Use a small window of spectrogram frames around the selected time index.
      const segmentWidth = Math.max(10, Math.floor(spectrogramResult.spectrogram.length * 0.05)); // 5% or 10 frames
      const startIdx = Math.max(0, timeIndex - Math.floor(segmentWidth / 2));
      const endIdx = Math.min(spectrogramResult.spectrogram.length - 1, timeIndex + Math.floor(segmentWidth / 2));
      console.log(`Reconstructing from spectrogram time segment ${startIdx} to ${endIdx}`);
      const reconstructedSamples = [];
      // Crude reconstruction: use the linear magnitude of the lowest frequency bin from each frame.
    for (let i = startIdx; i <= endIdx; i++) {
        if (spectrogramResult.spectrogram[i] && spectrogramResult.spectrogram[i].length > 0) {
          reconstructedSamples.push(dbToLinear(spectrogramResult.spectrogram[i][0])); // Use lowest bin
        }
      }
      samplesForSegment = new Float32Array(reconstructedSamples);
    }
    // Check if segment extraction yielded any samples
    if (!samplesForSegment || samplesForSegment.length === 0) {
      console.error("No samples available for FFT in this time slice.");
      return;
    }

    // --- Perform FFT ---
    const N = samplesForSegment.length;
    console.log("Number of samples for segment FFT:", N);

    // Use the FFT size defined in options, padding with zeros if necessary.
    // FFT algorithms are most efficient with powers of 2.
    const fftSizeToUse = Math.pow(2, Math.ceil(Math.log2(N)));
    // Create a buffer for the FFT input, padded with zeros.
    const paddedSamples = new Float32Array(fftSizeToUse).fill(0);
    paddedSamples.set(samplesForSegment);

    // Apply windowing (e.g., Hanning) to reduce spectral leakage - Important for better spectrum estimate
    const currentWindowType = currentOptions.windowType || 'hanning';
    const window = createWindow(fftSizeToUse, currentWindowType);
    const windowedSamples = paddedSamples.map((sample, i) => sample * window[i]);

    // Calculate FFT parameters: frequency resolution, max frequency.
    const samplingRate = currentOptions.samplingRate || 44100;
    const Np2 = Math.floor(fftSizeToUse / 2); // Number of useful frequency bins (excluding negative frequencies)
    const delta_f = samplingRate / fftSizeToUse; // Frequency resolution (Hz per bin)
    const f_max = Np2 * delta_f;
    // Generate the array of frequency values corresponding to each FFT bin.

    const frequencies = Array.from({ length: Np2 }, (_, i) => i * delta_f);
    
    // Perform the Fast Fourier Transform.
    const fft = new FFT(fftSizeToUse);
    const complexInput = fft.createComplexArray();
    const complexOutput = fft.createComplexArray();

    // Fill the real part of the complex input with windowed samples. Imaginary part remains 0.
    for (let i = 0; i < fftSizeToUse; i++) {
      complexInput[2 * i] = windowedSamples[i]; // Use windowed samples
      complexInput[2 * i + 1] = 0;
    }

    fft.transform(complexOutput, complexInput); // Execute FFT

    // --- Calculate Magnitude Spectrum ---
    // Calculate linear magnitude from the complex FFT output (sqrt(re^2 + im^2)).
    // Correct for the amplitude reduction caused by the window function using pre-calculated gains.
    const spectrum = new Array(Np2); // Array to store linear magnitude values
    const windowGain = WINDOW_GAINS[currentWindowType]; // Get gain for the used window
    const scaleFactor = windowGain > 0 ? (1 / windowGain) : 1; // Correction factor (avoid division by zero)

    for (let i = 0; i < Np2; i++) {
      const re = complexOutput[2 * i]; // Real part of the i-th frequency bin
      const im = complexOutput[2 * i + 1]; // Imaginary part
      const magnitude = Math.sqrt(re * re + im * im); // Calculate linear magnitude
      spectrum[i] = magnitude * scaleFactor; // Apply window gain correction
    }

    console.log(`Window-gain corrected magnitude time-slice spectrum (Gain: ${windowGain}, Scale: ${scaleFactor})`);

    // Store the calculated spectrum data in state for rendering the plot.
    setSpectrumData({
      spectrum: spectrum,  // Linear magnitude values
      frequencies: frequencies, // Corresponding frequencies
      maxFreq: f_max  // Max frequency represented
    });
  }, [filteredSamples, currentOptions, spectrogramResult, currentTimes]); // Dependencies, added filteredSamples and currentTimes

  /**
  * Memoized calculation of the frequency spectrum for the *entire* recording.
  * This performs a single large FFT on the (potentially downsampled) raw audio data.
  * It also filters and downsamples the resulting spectrum for efficient rendering
  * in the "Full Recording Spectrum" plot.
  *
  * @returns An object containing the full spectrum, frequencies, and downsampled points for plotting, or null if calculation fails.
  */
  const memoizedFullSpectrumData = useMemo(() => {
    console.log("[useMemo] Calculating Full Spectrum and Downsampling for Render...");

    // --- Input Data Preparation ---
    // Requires raw samples to perform the calculation.
    let samplesForFFTInput: Float32Array | null = null;
    if (filteredSamples && filteredSamples.length > 0) {
      samplesForFFTInput = filteredSamples;
    } else {
      console.error("[useMemo FullSpectrum] Filtered samples not available or empty.");
      return null; // Cannot calculate without samples
    }

    const N_original = samplesForFFTInput.length; // Original number of samples
    if (N_original === 0) {
      console.error("[useMemo FullSpectrum] Original samples length is 0.");
      return null;
    }
    
    // --- Input Downsampling (for very long recordings) ---
    // Limit the number of samples fed into the FFT to prevent performance issues or excessive memory usage.
    const MAX_FULL_SPECTRUM_SAMPLES = 1048576; /// 2^20 samples (around 23 seconds at 44.1kHz)
    let samplesForFFT: Float32Array;
    let effectiveSampleRate = currentOptions.samplingRate || 44100;
    if (N_original > MAX_FULL_SPECTRUM_SAMPLES) {
      const downsampleFactor = Math.ceil(N_original / MAX_FULL_SPECTRUM_SAMPLES);
      console.log(`[Full Spectrum] Downsampling by factor ${downsampleFactor} for full spectrum FFT of ${N_original} samples`);

      // Perform downsampling using a simple max-absolute-value approach within blocks.
      // This helps preserve peaks in the signal better than simple averaging.
      samplesForFFT = new Float32Array(MAX_FULL_SPECTRUM_SAMPLES);
      for (let i = 0; i < MAX_FULL_SPECTRUM_SAMPLES; i++) {
        const startIdx = Math.floor(i * downsampleFactor);
        const endIdx = Math.min(N_original, Math.floor((i + 1) * downsampleFactor));
        let maxAbs = 0;
        // Find the maximum absolute value in the block.
        for (let j = startIdx; j < endIdx; j++) {
          maxAbs = Math.max(maxAbs, Math.abs(samplesForFFTInput[j]));
        }
        // Assign the max absolute value with the corresponding sign.
        samplesForFFT[i] = maxAbs * Math.sign(samplesForFFTInput[startIdx]);
      }
      // Adjust the effective sample rate based on the downsampling factor.
      effectiveSampleRate = effectiveSampleRate / downsampleFactor;
      console.log(`[Full Spectrum] Downsampled to ${samplesForFFT.length} samples, new effective sample rate: ${effectiveSampleRate}Hz`);
    } else {
      // No downsampling needed if the original length is within the limit.
      samplesForFFT = samplesForFFTInput;
    }

    const N = samplesForFFT.length; // Number of samples for FFT
    if (N === 0) {
      console.error("[useMemo FullSpectrum] Samples length is 0 after potential downsampling.");
      return null;
    }

    // --- Perform Single Large FFT ---
    // Determine FFT size (next power of 2 >= N).
    const fftSize = Math.pow(2, Math.ceil(Math.log2(N)));
    const Np2 = Math.floor(fftSize / 2); // Number of useful frequency bins

    console.log(`[Full Spectrum] FFT Size: ${fftSize}, Sample Rate: ${effectiveSampleRate}, Max Freq: ${effectiveSampleRate / 2}Hz`);
    console.log(`[Full Spectrum] Frequency resolution: ${(effectiveSampleRate / fftSize).toFixed(4)} Hz`);

    // Pad samples, apply window function.
    const paddedSamples = new Float32Array(fftSize).fill(0);
    paddedSamples.set(samplesForFFT);
    const currentWindowType = currentOptions.windowType || 'hanning';
    const windowFunc = createWindow(fftSize, currentWindowType);
    const windowedSamples = paddedSamples.map((sample, i) => sample * windowFunc[i]);
    const fft = new FFT(fftSize);

    // Prepare complex buffers and perform FFT.
    const complexInput = fft.createComplexArray();
    const complexOutput = fft.createComplexArray();
    for (let i = 0; i < fftSize; i++) { complexInput[2 * i] = windowedSamples[i]; complexInput[2 * i + 1] = 0; }

    try {
      fft.transform(complexOutput, complexInput);
    } catch (fftError) {
      console.error("[useMemo FullSpectrum] Error during single FFT transform:", fftError);
      return null;
    }

    // Calculate final magnitude spectrum with window gain correction.
    const finalSpectrum = new Array(Np2);
    const windowGain = WINDOW_GAINS[currentWindowType];
    const scaleFactor = windowGain > 0 ? (1 / windowGain) : 1;
    for (let k = 0; k < Np2; k++) {
      const re = complexOutput[2 * k]; const im = complexOutput[2 * k + 1];
      const mag = Math.sqrt(re * re + im * im);
      finalSpectrum[k] = isFinite(mag) ? mag * scaleFactor : 0;   // Store magnitude, handle potential NaN/Infinity
    }
    // Calculate corresponding frequencies.
    const delta_f = effectiveSampleRate / fftSize;
    const frequencies = Array.from({ length: Np2 }, (_, k) => k * delta_f);


    // --- Log Peak Frequencies for Debugging ---
    let freqPeaks = [...finalSpectrum]
      .map((val, idx) => ({ val, idx }))
      .sort((a, b) => b.val - a.val)
      .slice(0, 3);

    console.log(`[Full Spectrum] Top frequency peaks:`);
    freqPeaks.forEach(peak => {
      console.log(`  ${frequencies[peak.idx].toFixed(2)} Hz: ${peak.val.toFixed(2)}`);
    });

    // --- Filter and Downsample Spectrum for Rendering ---
    // Filter frequencies based on min/max frequency options.
    const maxFreqToPlot = currentOptions.maxFreq || effectiveSampleRate / 2; // Use effective SR/2 if maxFreq not set
    const minFreqToPlot = currentOptions.minFreq || 0;
    const validFreqIndices = frequencies
      .map((f: number, i: number) => (f >= minFreqToPlot && f <= maxFreqToPlot ? i : -1)) // Get indices within range
      .filter((idx: number) => idx !== -1);

    let pointsToPlot: { freq: number; magnitude: number }[] = [];
    const MAX_RENDER_POINTS = 200;  // Limit points for the SVG path to maintain performance

    if (validFreqIndices.length > 0) {
      // Downsample the valid frequency points if necessary.
      if (validFreqIndices.length > MAX_RENDER_POINTS) {
        const factor = Math.ceil(validFreqIndices.length / MAX_RENDER_POINTS);
        // Use max-magnitude downsampling within blocks to preserve peaks visually.
        for (let i = 0; i < validFreqIndices.length; i += factor) {
          const segmentEnd = Math.min(i + factor, validFreqIndices.length);
          let maxMagInSegment = -Infinity; let indexAtMax = -1;
          // Find the index with the maximum magnitude in this block.\
          for (let j = i; j < segmentEnd; j++) {
            const currentIdx = validFreqIndices[j];
            if (finalSpectrum[currentIdx] > maxMagInSegment) {
              maxMagInSegment = finalSpectrum[currentIdx];
              indexAtMax = currentIdx;
            }
          }
          // Add the point with the maximum magnitude to the plot list.
          if (indexAtMax !== -1) { pointsToPlot.push({ freq: frequencies[indexAtMax], magnitude: maxMagInSegment }); }
        }
      } else {
        // No downsampling needed if already below the limit.
        pointsToPlot = validFreqIndices.map((idx: number) => ({ freq: frequencies[idx], magnitude: finalSpectrum[idx] }));
      }
    } else {
      console.log("[useMemo] No valid frequency points to plot after filtering.");
    }

    // --- End Filtering/Downsampling for Render ---
    console.log(`[useMemo] Full Spectrum processing complete. Points for render: ${pointsToPlot.length}`);
    // Return the full spectrum, frequencies, and the downsampled points for plotting.
    return { spectrum: finalSpectrum, frequencies, pointsToPlot };

  }, [filteredSamples, currentOptions.samplingRate, currentOptions.windowType, currentOptions.minFreq, currentOptions.maxFreq]);


  /**
   * Memoized color calculation function.
   * Caches results of `getColorFromMagnitude` to avoid redundant calculations,
   * especially since the same magnitude values might appear many times in the spectrogram.
   * Cache key includes magnitude (rounded), dynamic range, and color map name.
   *
   * @returns A function that takes a magnitude value and returns its cached color string.
   */
  const getColorMemoized = useMemo(() => {
    // Use a Map for efficient caching.
    const colorCache = new Map<string, string>();
    return (value: number) => {
      // Use the current dynamic range from options for the cache key.
      const dynamicRangeToUse = options.dynamicRange ?? 50;
      // Create a unique key based on value (rounded), dynamic range, and color map.
      const key = `${Math.round(value * 100)}-${dynamicRangeToUse}-${colorMap}`;
      // If color is not in cache, calculate and store it.
      if (!colorCache.has(key)) {
        colorCache.set(key, getColorFromMagnitude(value, dynamicRangeToUse, colorMap));
      }
      // Return the cached color (or black fallback).
      return colorCache.get(key) || 'rgb(0,0,0)'; // Fallback color
    };
  }, [options.dynamicRange, colorMap]);

  /**
   * Handles touch events on the spectrogram area *when in rotated view*.
   * Calculates the time corresponding to the touch's Y position, finds the nearest
   * time frame index, updates the selected time state, triggers the calculation
   * of the spectrum for that time slice, and updates the selection indicator line.
   *
   * @param event The touch event object from TouchableWithoutFeedback.
   */

  const handleSpectrogramClick = useCallback((event: any) => {
    // Only active in rotated view, when not loading, and if time data exists.
    if (!isRotated || isLoading || currentTimes.length === 0 || !spectrogramResult) return;

    // Extract Y coordinate of the touch event relative to the SVG element.
    const { locationY } = event.nativeEvent;
    // Get layout parameters for the rotated plot.
    const rotatedPaddingTop = 20; // Use defined padding
    const rotatedPlotHeight = Math.min(windowWidth - 60, 400); // Same height calc as in renderRotated
    const duration = currentOptions.duration ?? 0; // Get total duration

    // --- Map Y Position to Time ---
    // Calculate clicked Y relative to the plot area's top edge.
    const clickedY = locationY - rotatedPaddingTop;
    // Convert Y position to a time ratio (0=bottom, 1=top of plot). Clamp to [0, 1].
    // Remember Y=0 is the top edge, Y=plotHeight is the bottom edge. Time increases upwards.
    const clickedTimeRatio = duration > 0 ? Math.max(0, Math.min(1, (rotatedPlotHeight - clickedY) / rotatedPlotHeight)) : 0;
    // Calculate the actual time value corresponding to the touch position.
    const clickedTime = clickedTimeRatio * duration;

    // --- Find Nearest Time Index ---
    // Find the index in the `currentTimes` array closest to the calculated `clickedTime`.
    let closestTimeIndex = 0;
    let minDiff = Infinity;
    for (let i = 0; i < currentTimes.length; i++) {
      const diff = Math.abs(currentTimes[i] - clickedTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestTimeIndex = i;
      }
    }

    const timeIndex = closestTimeIndex; // The index of the selected time frame.

    console.log(`Clicked at Y=${locationY}, Time: ${clickedTime.toFixed(3)}s, closest index: ${timeIndex}`);

    // Ensure the found index is valid.
    if (timeIndex >= 0 && timeIndex < currentTimes.length) {
      // Update state with the selected index and formatted time string.
      setSelectedTimeIndex(timeIndex);
      setSelectedTime(currentTimes[timeIndex].toFixed(3));

      // --- Update Selection Indicator (Horizontal Line) ---
      // Map the selected time value back to a Y position for the indicator line.
      const selectedTimeValue = currentTimes[timeIndex];
      const timeToY_rotated = (timeVal: number): number => {
        // Maps time [0, duration] to Y-pixels [bottom, top]
        if (duration <= 0) return rotatedPaddingTop + rotatedPlotHeight / 2; // Center if no duration
        return rotatedPaddingTop + rotatedPlotHeight - (timeVal / duration) * rotatedPlotHeight;
      };
      const yPos = timeToY_rotated(selectedTimeValue); // Y position for the line center
      const rotatedPaddingLeft = 55; // Still need this for positioning
      const aspectRatio = 0.7;
      const rotatedPlotWidth = rotatedPlotHeight * (1 / aspectRatio); // Use calculated width

      // Update the selectionRect state to draw a horizontal line.
      setSelectionRect({
        x: rotatedPaddingLeft, // Start at the left edge of the plot area
        y: yPos - 1, // Center the line vertically around yPos (line height is 2)
        width: rotatedPlotWidth, // Span the full width of the plot area
        height: 2, // Height (thickness) of the line
        visible: true // Make the line visible
      });

      // Trigger calculation of the frequency spectrum for the newly selected time index
      calculateTimeSliceSpectrum(timeIndex); // Pass the index
    } else {
      console.error(`Invalid timeIndex: ${timeIndex}, times length: ${currentTimes.length}`);
    }
  }, [isRotated, isLoading, currentOptions, windowWidth, calculateTimeSliceSpectrum, spectrogramResult]); // Added dependencies


  // --- Rendering Functions ---

  /**
   * Renders the time-domain waveform plot for the currently selected audio segment.
   * Extracts the relevant raw samples, normalizes them, and draws them as an SVG path.
   * Only renders if raw samples are available and a time index is selected.
   *
   * @returns A React Native View containing the SVG plot or null.
   */
  const renderSegmentTimeDomain = () => {
    if (!filteredSamples || selectedTimeIndex === null || selectedTimeIndex < 0 || !currentTimes || selectedTimeIndex >= currentTimes.length) {
      return null; // Cannot render without raw samples or a valid selection
    }

    // --- Extract Sample Segment ---
    // (This logic mirrors the start of `calculateTimeSliceSpectrum`)
    const samplesPerTimeFrame = Math.floor((filteredSamples.length / currentTimes.length));
    const startSampleIndex = selectedTimeIndex * samplesPerTimeFrame;
    const segmentLength = currentOptions.fftSize || 1024; // Use FFT size as the length of the segment to display
    const endSampleIndex = Math.min(startSampleIndex + segmentLength, filteredSamples.length);
    const samplesForSegment = filteredSamples.slice(startSampleIndex, endSampleIndex);

    if (samplesForSegment.length === 0) {
      console.error("No samples found for selected segment time domain plot.");
      return null;
    }

    // --- Normalize for Plotting ---
    // Find the maximum absolute amplitude in the segment.
    const maxAbs = Math.max(...samplesForSegment.map(Math.abs));
    // Normalize samples to the range [-1, 1] for plotting.
    const normalizedSamples = Array.from(samplesForSegment).map(sample => maxAbs === 0 ? 0 : sample / maxAbs);

    // --- Layout Calculations (Consistent with renderSpectrum plot) ---
    const paddingLeft = 55; // Use standard padding
    const paddingRight = 25; // Slightly more right padding than spectrogram
    const paddingTop = 45;  // Increased top padding for title
    const paddingBottom = 35; // Standard bottom padding

    const _plotWidth = Math.min(windowWidth - paddingLeft - paddingRight, 500); // Calculate plot width
    const plotWidth = _plotWidth; // Use shared segment plot height
    const plotHeight = SEGMENT_PLOT_HEIGHT; // Use shared segment plot height
    const svgWidth = plotWidth + paddingLeft + paddingRight;
    const svgHeight = plotHeight + paddingTop + paddingBottom;

    // --- Axis Mapping Functions ---
    const numSamplesToPlot = normalizedSamples.length;
    const samplingRate = currentOptions.samplingRate || 44100;
    const segmentDuration = numSamplesToPlot / samplingRate; // Duration of this segment in seconds

    // X-axis: Maps time within the segment [0, segmentDuration] to horizontal pixel position [0, plotWidth].
    const timeToX = (timeInSegment: number): number => {
      if (numSamplesToPlot <= 1) return paddingLeft + plotWidth / 2; // Center if only one point
      // Map time from [0, segmentDuration] to [0, plotWidth]
      const timeRatio = segmentDuration > 0 ? timeInSegment / segmentDuration : 0;
      return paddingLeft + timeRatio * plotWidth;
    };

    // Y-axis: Maps normalized amplitude [-1, 1] to vertical pixel position [plotHeight, 0].
    const ampToY = (amplitude: number): number => {
      // Map range [-1, 1] to [plotHeight, 0] within the top/bottom padded plot area.
      return paddingTop + plotHeight / 2 * (1 - amplitude);
    };

    // --- Generate SVG Path Data ---
    // Create the 'd' attribute string for the SVG <Path> element.
    const pathData = normalizedSamples.map((sample, i) => {
      // Calculate time for this sample within the segment
      const timeInSegment = i / samplingRate; // Calculate time for this sample
      const x = timeToX(timeInSegment); // Get X pixel position
      const y = ampToY(sample); // Get Y pixel position
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' '); // Join points into a single path string

    // --- Generate Ticks ---
    // X-axis Ticks (Time in milliseconds)
    const numXTicks = 5; // Number of time tick intervals
    const timeTickValues = Array.from({ length: numXTicks + 1 }, (_, i) =>
      (i * segmentDuration) / numXTicks
    ); // Evenly spaced time values within the segment duration

    // Y-axis Ticks (Amplitude)
    const ampTickValues = [1.0, 0.5, 0.0, -0.5, -1.0]; // Fixed amplitude ticks

    // --- Render SVG ---
    return (
      <View style={{ marginBottom: 10 }}> {/* Add margin between segment plots */}
        <Svg width={svgWidth} height={svgHeight}>
          {/* Title */}
          <SvgText x={svgWidth / 2} y={paddingTop - 25} fill="white" fontSize="14" fontWeight="bold" textAnchor="middle">
            {`Time Domain Segment at t=${selectedTime ?? 'N/A'}s`}
          </SvgText>
          {/* Background */}
          <Rect x={paddingLeft} y={paddingTop} width={plotWidth} height={plotHeight} fill="#001a1a" stroke="#333" strokeWidth="1" />

          {/* Grid Lines (Horizontal for Amplitude) */}
          {ampTickValues.map((val, i) => (
            <React.Fragment key={`amp-grid-${i}`}>
              <Line x1={paddingLeft} y1={ampToY(val)} x2={paddingLeft + plotWidth} y2={ampToY(val)} stroke="#333" strokeWidth="1" strokeDasharray={val === 0.0 ? "2,2" : "5,5"} />
              <SvgText x={paddingLeft - 8} y={ampToY(val) + 4} fill="white" textAnchor="end" fontSize="10">{val.toFixed(1)}</SvgText>
            </React.Fragment>
          ))}

          {/* Grid Lines (Vertical for Time) */}
          {timeTickValues.map((timeVal, i) => (
            <Line key={`time-grid-${i}`} x1={timeToX(timeVal)} y1={paddingTop} x2={timeToX(timeVal)} y2={paddingTop + plotHeight} stroke="#333" strokeWidth="1" strokeDasharray="5,5" />
          ))}

          {/* Main Axes Lines (on top of grid) */}
          <Line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={paddingTop + plotHeight} stroke="white" strokeWidth="1.5" />
          <Line x1={paddingLeft} y1={paddingTop + plotHeight} x2={paddingLeft + plotWidth} y2={paddingTop + plotHeight} stroke="white" strokeWidth="1.5" />

          {/* Signal Waveform Path */}
          <Path d={pathData} stroke="#00ffff" strokeWidth="1.5" fill="none" />

          {/* X Ticks (Time) */}
          {timeTickValues.map((timeVal, i) => {
            // Format time ticks nicely (e.g., in milliseconds)
            const timeLabel = (timeVal * 1000).toFixed(0); // Format time as milliseconds
            const xPos = timeToX(timeVal);
            return (
              <React.Fragment key={`time-tick-${i}`}>
                {/* Tick mark */}
                <Line x1={xPos} y1={paddingTop + plotHeight} x2={xPos} y2={paddingTop + plotHeight + 5} stroke="white" strokeWidth="1" />
                {/* Tick label */}
                <SvgText x={xPos} y={paddingTop + plotHeight + 15} fill="white" textAnchor="middle" fontSize="10">{timeLabel}</SvgText>
              </React.Fragment>
            );
          })}

          {/* Axis Titles */}
          <SvgText x={paddingLeft + plotWidth / 2} y={svgHeight - 5} fill="white" fontSize="12" textAnchor="middle">Time [ms]</SvgText>
          <SvgText x={20} y={paddingTop + plotHeight / 2} fill="white" fontSize="12" textAnchor="middle" transform={`rotate(-90, 20, ${paddingTop + plotHeight / 2})`}>Amplitude</SvgText>
        </Svg>
      </View>
    );
  };

  /**
   * Renders the frequency spectrum plot for the currently selected time slice.
   * Uses the data stored in the `spectrumData` state (calculated by `calculateTimeSliceSpectrum`).
   * Plots linear magnitude against frequency.
   *
   * @returns A React Native View containing the SVG plot or null.
   */
  const renderSpectrum = () => {
    if (!spectrumData || !spectrumData.spectrum || !spectrumData.frequencies) {
      return null;
    }

    // --- Layout Calculations (Consistent with renderSegmentTimeDomain) ---
    const paddingLeft = 55;
    const paddingRight = 25;
    const paddingTop = 45;
    const paddingBottom = 35;

    const _plotWidth = Math.min(windowWidth - paddingLeft - paddingRight, 500);
    const plotWidth = _plotWidth;
    const plotHeight = SEGMENT_PLOT_HEIGHT; // Use shared segment plot height
    const svgWidth = plotWidth + paddingLeft + paddingRight;
    const svgHeight = plotHeight + paddingTop + paddingBottom;
    const maxFreq = Math.min(spectrumData.maxFreq, currentOptions.maxFreq ?? 22050); // Determine frequency range to plot based on options.

    // Filter frequency indices to include only those within the specified min/max range.
    const freqIndicesToPlot = spectrumData.frequencies
      .map((f: number, i: number) => (f >= (currentOptions.minFreq ?? 0) && f <= maxFreq ? i : -1)) // Add types for f, i
      .filter((idx: number) => idx !== -1); // Add type for idx

    // Don't render if no frequencies fall within the specified range.    
    if (freqIndicesToPlot.length === 0) return null;

    // Get the actual min/max frequencies that will be plotted.
    const minVisibleFreq = spectrumData.frequencies[freqIndicesToPlot[0]];
    const maxVisibleFreq = spectrumData.frequencies[freqIndicesToPlot[freqIndicesToPlot.length - 1]];

    // --- Axis Mapping Functions ---
    // X-axis: Maps frequency [minVisibleFreq, maxVisibleFreq] to horizontal pixel [0, plotWidth].
    const freqToX = (freq: number): number => {
      if (maxVisibleFreq === minVisibleFreq) return paddingLeft + plotWidth / 2;
      return paddingLeft + ((freq - minVisibleFreq) / (maxVisibleFreq - minVisibleFreq)) * plotWidth;
    };
    // Filter magnitudes corresponding to the frequencies being plotted.
    const visibleMagnitudes = freqIndicesToPlot.map(i => spectrumData.spectrum[i]);
    // Find the maximum magnitude to scale the Y-axis. Use a small epsilon to avoid issues with zero magnitude.
    const maxMagnitude = Math.max(1e-6, Math.max(...visibleMagnitudes));
    // Generate "nice" magnitude ticks for the Y-axis using the helper function.
    const magTicks = getYAxisTicks(maxMagnitude);
    // Get the actual highest tick value for scaling (might be slightly different from maxMagnitude).
    const actualMaxTick = magTicks[magTicks.length - 1];

    // Y-axis: Maps linear magnitude [0, actualMaxTick] to vertical pixel [plotHeight, 0].
    const magToY = (mag: number): number => {
      if (actualMaxTick === 0) return paddingTop + plotHeight;
      return paddingTop + plotHeight - (mag / actualMaxTick) * plotHeight;
    };

    // --- Generate Ticks ---
    // X-axis Ticks (Frequency)
    const numFreqTicks = 5; // Number of frequency tick intervals
    const freqTickValues = Array.from({ length: numFreqTicks + 1 }, (_, i: number) =>
      minVisibleFreq + (i * (maxVisibleFreq - minVisibleFreq)) / numFreqTicks
    ); // Evenly spaced frequencies

    // --- Render SVG ---
    return (
      <View style={{ marginBottom: 0 }}>
        <Svg width={svgWidth} height={svgHeight}>
          {/* Title */}
          <SvgText x={svgWidth / 2} y={25} fill="white" fontSize="16" fontWeight="bold" textAnchor="middle">
            {`Frequency Spectrum at t=${selectedTime ?? 'N/A'}s`}
          </SvgText>
          {/* Background */}
          <Rect x={paddingLeft} y={paddingTop} width={plotWidth} height={plotHeight} fill="#001a1a" stroke="#333" strokeWidth="1" />
          {/* Horizontal grid lines & Y Ticks */}
          {magTicks.map((mag: number, i: number) => ( // Add types for mag, i
            <React.Fragment key={`mag-grid-${i}`}>
              <Line x1={paddingLeft} y1={magToY(mag)} x2={paddingLeft + plotWidth} y2={magToY(mag)} stroke="#333" strokeWidth="1" strokeDasharray="5,5" />
              <SvgText x={paddingLeft - 5} y={magToY(mag) + 5} fill="white" fontSize="11" textAnchor="end">
                {mag.toFixed(mag < 10 ? 1 : 0)}
              </SvgText>
            </React.Fragment>
          ))}
          {/* Vertical grid lines & X Ticks */}
          {freqTickValues.map((freq: number, i: number) => (
            <React.Fragment key={`freq-grid-${i}`}>
              <Line x1={freqToX(freq)} y1={paddingTop} x2={freqToX(freq)} y2={paddingTop + plotHeight} stroke="#333" strokeWidth="1" strokeDasharray="5,5" />
              <SvgText x={freqToX(freq)} y={paddingTop + plotHeight + 17} fill="white" fontSize="11" textAnchor="middle">
                {freq === 0 ? "0" : freq < 1000 ? Math.round(freq) : `${(freq / 1000).toFixed(1)}k`}
          </SvgText>
            </React.Fragment>
          ))}

          {/* Main Axes Lines (on top of grid) */}
          <Line
            x1={paddingLeft}
            y1={paddingTop}
            x2={paddingLeft}
            y2={paddingTop + plotHeight}
            stroke="white"
            strokeWidth="1.5"
          />
          <Line
            x1={paddingLeft}
            y1={paddingTop + plotHeight}
            x2={paddingLeft + plotWidth}
            y2={paddingTop + plotHeight}
            stroke="white"
            strokeWidth="1.5"
          />

          {/* Spectrum Path */}
          <Path
            d={freqIndicesToPlot.map((idx: number, plotIdx: number) => { // Add types for idx, plotIdx
              const freq = spectrumData.frequencies[idx];
              const mag = spectrumData.spectrum[idx];
              const x = freqToX(freq);
              const y = magToY(mag);
              if (isNaN(x) || isNaN(y)) return '';
              const command = plotIdx === 0 ? 'M' : 'L';
              return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
            }).filter((s: string) => s !== '').join(' ')}
            fill="none" stroke="#00ffff" strokeWidth="2"
          />
          {/* Axis Titles */}
          <SvgText x={paddingLeft + plotWidth / 2} y={svgHeight - 5} fill="white" fontSize="14" textAnchor="middle">Frecventa [Hz]</SvgText>
          <SvgText x={20} y={paddingTop + plotHeight / 2} fill="white" fontSize="14" textAnchor="middle" transform={`rotate(-90, 20, ${paddingTop + plotHeight / 2})`}>Modul</SvgText>
        </Svg>
      </View>
    );
  };

  /**
   * Memoized rendering function for the overall time domain signal plot (non-rotated view).
   * Uses raw samples if available, otherwise falls back to a rough reconstruction from spectrogram data.
   * Applies downsampling for performance with long signals.
   *
   * @returns A React Native View containing the SVG plot or a placeholder Text element.
   */
  const renderTimeDomain = useMemo(() => {
    // Show loading/unavailable text if data isn't ready.
    if (isLoading) return <Text style={styles.plotTitle}>Time Domain Signal (Loading...)</Text>;
    if (!filteredSamples && !spectrogramResult) return <Text style={styles.plotTitle}>Time Domain Signal (Unavailable)</Text>;

    let signalToPlot: number[]; // Array of normalized samples [-1, 1] for plotting
    let timeDuration: number; // Total duration of the signal in seconds

    // --- Prepare Signal Data ---
    // 1. Use filtered samples if available (preferred)
    if (filteredSamples) {
      console.log("Rendering Time Domain from filtered samples");
      // --- Optional Downsampling for large rawSamples ---
      const MAX_TIME_POINTS = 8000; // Limit points rendered for performance
      let effectiveSamples = filteredSamples;
      if (filteredSamples.length > MAX_TIME_POINTS) {
        const factor = Math.ceil(filteredSamples.length / MAX_TIME_POINTS);
        console.log(`Downsampling time domain plot by factor ${factor}`);
        // Downsample using max-absolute-value approach (similar to full spectrum input downsampling)
        effectiveSamples = new Float32Array(Math.ceil(filteredSamples.length / factor));
        for (let i = 0; i < effectiveSamples.length; i++) {
          let maxAbs = 0;
          for (let j = 0; j < factor; j++) {
            const idx = i * factor + j;
            if (idx < filteredSamples.length) {
              maxAbs = Math.max(maxAbs, Math.abs(filteredSamples[idx]));
            }
          }
          // Keep the sign of the first sample in the block for the maxAbs value
          const sign = (i * factor < filteredSamples.length) ? Math.sign(filteredSamples[i * factor]) : 1;
          effectiveSamples[i] = maxAbs * sign;
        }
        console.log(`Downsampled time domain to ${effectiveSamples.length} points`);
      }
      
      // Normalize the (potentially downsampled) samples to [-1, 1].
      const maxAbs = effectiveSamples.length > 0 ? Math.max(...effectiveSamples.map(Math.abs)) : 0;
      signalToPlot = Array.from(effectiveSamples).map(sample => maxAbs === 0 ? 0 : sample / maxAbs);
      // Calculate duration based on the *original* number of samples and sample rate.
      timeDuration = filteredSamples.length / (currentOptions.samplingRate || 44100); 
    }
    // 2. Fallback: Reconstruct from spectrogram data (less accurate) 
    else if (spectrogramResult) { // Explicitly check spectrogramResult isn't null
      console.log("Rendering Time Domain fallback from spectrogram (less accurate)");
      // Crude reconstruction: Average the linear magnitude of the first few frequency bins for each time frame.
      const numBins = Math.min(20, spectrogramResult.spectrogram[0]?.length || 0);
      const reconstructedSignal = spectrogramResult.spectrogram.map((frame: number[]) => { // Add type
        let sum = 0;
        for (let j = 0; j < numBins; j++) 
          sum += dbToLinear(frame[j] ?? -160);
        return sum / numBins;
      });

      // Normalize the reconstructed signal.
      const maxAbsReconstructed = Math.max(...reconstructedSignal.map(Math.abs));
      signalToPlot = reconstructedSignal.map((sample: number) => maxAbsReconstructed === 0 ? 0 : sample / maxAbsReconstructed); // Add type
      // Get duration from the spectrogram result options.
      timeDuration = spectrogramResult.options.duration ?? 0; // Use duration from result with default
    } else {
      // Should not happen if initial checks pass, but handle defensively.
      return <Text style={styles.plotTitle}>Time Domain Signal (Error)</Text>; // Should not happen
    }

    const paddingLeft = 55;
    const paddingRight = 25;
    const paddingTop = 20;
    const paddingBottom = 35;
    const plotHeight = 150;
    const svgWidth = Dimensions.get('window').width - 20; // Use most of screen width
    const plotWidth = svgWidth - paddingLeft - paddingRight;
    const svgHeight = plotHeight + paddingTop + paddingBottom;

    // --- Ticks and Path ---
    // Generate time ticks using the helper function.
    const timeDomainTimeTicks = generateTimeTicks(timeDuration); // Use re-added helper
    // Generate SVG path data string for the waveform.
    let pathData = signalToPlot.map((sample, i) => {
      // Map sample index to X position (0 to plotWidth).
      const x = paddingLeft + (i / (signalToPlot.length - 1)) * plotWidth;
      // Map normalized amplitude [-1, 1] to Y position (plotHeight to 0).
      const y = paddingTop + plotHeight / 2 * (1 - sample);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');

    // --- Render SVG ---
    return (
      <View style={styles.timeDomainContainer}>
        <Text style={styles.plotTitle}>Time Domain Signal</Text>
        <Svg height={svgHeight} width={svgWidth}>
          {/* Background & Grid */}
          <Rect x={paddingLeft} y={paddingTop} width={plotWidth} height={plotHeight} fill="#111" />
          {/* Horizontal Amplitude Grid Lines */}
          <Line x1={paddingLeft} y1={paddingTop + plotHeight / 4} x2={paddingLeft + plotWidth} y2={paddingTop + plotHeight / 4} stroke="#333" strokeWidth="1" />
          <Line x1={paddingLeft} y1={paddingTop + plotHeight / 2} x2={paddingLeft + plotWidth} y2={paddingTop + plotHeight / 2} stroke="#333" strokeWidth="1" strokeDasharray="5,5" />
          <Line x1={paddingLeft} y1={paddingTop + 3 * plotHeight / 4} x2={paddingLeft + plotWidth} y2={paddingTop + 3 * plotHeight / 4} stroke="#333" strokeWidth="1" />
          {/* Vertical Time Grid Lines */}
          {timeDomainTimeTicks.map((time: number, i: number) => (<Line key={`time-grid-${i}`} x1={paddingLeft + (time / timeDuration) * plotWidth} y1={paddingTop} x2={paddingLeft + (time / timeDuration) * plotWidth} y2={paddingTop + plotHeight} stroke="#333" strokeWidth="1" strokeDasharray={i === 0 ? "" : "5,5"} />))}
          {/* Axes */}
          <Line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={paddingTop + plotHeight} stroke="white" strokeWidth="1" />
          <Line x1={paddingLeft} y1={paddingTop + plotHeight} x2={paddingLeft + plotWidth} y2={paddingTop + plotHeight} stroke="white" strokeWidth="1" />
          {/* Y Labels */}
          {[1.0, 0.5, 0.0, -0.5, -1.0].map((val, i) => (<SvgText key={`amp-label-${i}`} x={paddingLeft - 8} y={paddingTop + plotHeight / 2 * (1 - val) + 4} fill="white" textAnchor="end" fontSize="10">{val.toFixed(1)}</SvgText>))}
          {/* Signal Path */}
          <Path d={pathData} stroke="cyan" strokeWidth="1.5" fill="none" />
          {/* X Labels */}
          {timeDomainTimeTicks.map((time: number, i: number) => (
            <React.Fragment key={`time-${i}`}>
              <Line x1={paddingLeft + (time / timeDuration) * plotWidth} y1={paddingTop + plotHeight} x2={paddingLeft + (time / timeDuration) * plotWidth} y2={paddingTop + plotHeight + 5} stroke="white" strokeWidth="1" />
              <SvgText x={paddingLeft + (time / timeDuration) * plotWidth} y={paddingTop + plotHeight + 15} fill="white" textAnchor="middle" fontSize="10">{time < 1 ? time.toFixed(2) : time.toFixed(1)}</SvgText>
            </React.Fragment>
          ))}
          {/* Titles */}
          <SvgText x={paddingLeft + plotWidth / 2} y={svgHeight - 5} fill="white" textAnchor="middle" fontSize="12">Timp [s]</SvgText>
          <SvgText x={15} y={paddingTop + plotHeight / 2} fill="white" textAnchor="middle" fontSize="12" transform={`rotate(-90, 15, ${paddingTop + plotHeight / 2})`}>Amplitudine</SvgText>
        </Svg>
      </View>
    );
  }, [isLoading, filteredSamples, spectrogramResult, currentOptions.samplingRate]); // Added dependencies for useMemo

  /**
   * Renders the frequency spectrum plot for the *entire* recording (non-rotated view).
   * Uses the pre-calculated and downsampled data from `memoizedFullSpectrumData`.
   *
   * @returns A React Native View containing the SVG plot or a placeholder Text element.
   */
  const renderFullSpectrum = () => {
    console.log("[RenderFullSpectrum SVG] Rendering using pre-calculated points...");
    // Get the pre-calculated data.
    const fullSpectrumResult = memoizedFullSpectrumData;

    // Show placeholder text if data is not yet calculated or calculation failed.
    if (!fullSpectrumResult) {
      console.log("[RenderFullSpectrum SVG] Memoized data is null.");
      return <Text style={styles.fullSpectrumTitle}>Full Recording Spectrum (Calculating...)</Text>;
    }

    // Destructure the calculated data.
    const { spectrum, frequencies, pointsToPlot } = fullSpectrumResult;

    // Check if the downsampled points array exists and is not empty.
    if (!pointsToPlot) { 
      console.log("[RenderFullSpectrum SVG] pointsToPlot is missing after calculation.");
      return <Text style={styles.fullSpectrumTitle}>Full Recording Spectrum (Unavailable)</Text>;
    }

    // Check if pointsToPlot is empty after filtering/downsampling in useMemo
    if (pointsToPlot.length === 0) {
      console.log("[RenderFullSpectrum SVG] No points to plot after processing in useMemo.");
      return <Text style={styles.fullSpectrumTitle}>Full Recording Spectrum (No data in range)</Text>;
    }

    // --- Layout, Scaling, Ticks (Similar to renderSpectrum) ---
    // Get frequency range from options.
    const maxFreqToPlot = currentOptions.maxFreq || (currentOptions.samplingRate || 44100) / 2;
    const minFreqToPlot = currentOptions.minFreq || 0;
    // Get actual min/max frequencies from the downsampled data being plotted.
    const minVisibleFreq = pointsToPlot[0].freq;
    const maxVisibleFreq = pointsToPlot[pointsToPlot.length - 1].freq;
    // Layout dimensions.
    const paddingLeft = 55; const paddingRight = 25; const paddingTop = 20; const paddingBottom = 35;
    const svgWidth = Dimensions.get('window').width - 20;
    const spectrumWidth = svgWidth - paddingLeft - paddingRight;
    const spectrumHeight = 150;
    const svgHeight = spectrumHeight + paddingTop + paddingBottom;
    // Find max magnitude among the points to plot for Y-axis scaling.
    let maxMagnitude = 0;
    if (pointsToPlot.length > 0) {
      // ++ Add type for p ++ 
      maxMagnitude = Math.max(1e-6, Math.max(...pointsToPlot.map((p: { magnitude: number }) => p.magnitude)));
    }
    // Generate Y-axis ticks (magnitude) and find the actual max tick value.
    const magTicks = getYAxisTicks(maxMagnitude);
    const actualMaxTick = magTicks.length > 0 ? magTicks[magTicks.length - 1] : 1;

    // Y-axis mapping function (Magnitude to Pixel Y).
    const magToY = (mag: number): number => {
      if (actualMaxTick === 0) return paddingTop + spectrumHeight;
      return paddingTop + spectrumHeight - (mag / actualMaxTick) * spectrumHeight;
    };

    // Generate X-axis ticks (frequency).
    const numFreqTicks = 5;
    const freqTickValues = Array.from({ length: numFreqTicks + 1 }, (_, i) => minVisibleFreq + (i * (maxVisibleFreq - minVisibleFreq)) / numFreqTicks);
    // X-axis mapping function (Frequency to Pixel X).
    const freqToX = (freq: number): number => {
      if (maxVisibleFreq === minVisibleFreq) return paddingLeft + spectrumWidth / 2;
      return paddingLeft + ((freq - minVisibleFreq) / (maxVisibleFreq - minVisibleFreq)) * spectrumWidth;
    };
    // --- End Layout, Scaling, Ticks ---

    // --- Create SVG Path data string from pre-calculated pointsToPlot ---
    const pathData = pointsToPlot.map((point: { freq: number; magnitude: number }, i: number) => {
      const x = freqToX(point.freq);
      const y = magToY(point.magnitude);
      if (isNaN(x) || isNaN(y)) return ''; // Skip invalid points
      const command = i === 0 ? 'M' : 'L';
      return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
    }).filter((s: string) => s !== '').join(' ');

    // --- Render SVG ---
    return (
      <View style={styles.fullSpectrumContainer}>
        <Text style={styles.fullSpectrumTitle}>Full Recording Spectrum</Text>
        <Svg height={svgHeight} width={svgWidth}>
          {/* Background Rect */}
          <Rect x={paddingLeft} y={paddingTop} width={spectrumWidth} height={spectrumHeight} fill="#111" />
          {/* Y-axis Grid Lines & Labels */}
          {magTicks.map((tick: number, i: number) => {
            const yPos = magToY(tick);
            return (
              <React.Fragment key={`mag-tick-svg-${i}`}>
                <Line x1={paddingLeft} y1={yPos} x2={paddingLeft + spectrumWidth} y2={yPos} stroke="#333" strokeWidth={0.5} strokeDasharray="3,3" />
              <SvgText
                  x={paddingLeft - 8}
                  y={yPos + 4}
                fill="white"
                  textAnchor="end"
                  fontSize="10">
                  {tick >= 10000 ? `${(tick / 1000).toFixed(0)}k` : tick >= 1000 ? `${(tick / 1000).toFixed(1)}k` : tick.toFixed(tick < 10 ? 1 : 0)}
              </SvgText>
            </React.Fragment>
            );
          })}
          {/* X-axis Grid Lines & Labels */}
          {freqTickValues.map((freq: number, i: number) => {
            const xPos = freqToX(freq);
            const label = freq >= 1000 ? `${(freq / 1000).toFixed(1)}k` : Math.round(freq).toString();
            return (
              <React.Fragment key={`freq-tick-svg-${i}`}>
                <Line x1={xPos} y1={paddingTop} x2={xPos} y2={paddingTop + spectrumHeight} stroke="#333" strokeWidth={0.5} strokeDasharray="3,3" />
                <Line x1={xPos} y1={paddingTop + spectrumHeight} x2={xPos} y2={paddingTop + spectrumHeight + 5} stroke="white" strokeWidth="1" />
                <SvgText x={xPos} y={paddingTop + spectrumHeight + 15} fill="white" textAnchor="middle" fontSize="10">{label}</SvgText>
              </React.Fragment>
            );
          })}
          {/* Main Axes Lines (on top of grid) */}
          <Line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={paddingTop + spectrumHeight} stroke="white" strokeWidth="1" />
          <Line x1={paddingLeft} y1={paddingTop + spectrumHeight} x2={paddingLeft + spectrumWidth} y2={paddingTop + spectrumHeight} stroke="white" strokeWidth="1" />
          {/* Spectrum Path */}
          <Path d={pathData} stroke="cyan" strokeWidth="1.5" fill="none" />
          {/* Axis Titles */}
          <SvgText x={paddingLeft + spectrumWidth / 2} y={svgHeight - 5} fill="white" textAnchor="middle" fontSize="12">Frecventa [Hz]</SvgText>
          <SvgText x={15} y={paddingTop + spectrumHeight / 2} fill="white" textAnchor="middle" fontSize="12" transform={`rotate(-90, 15, ${paddingTop + spectrumHeight / 2})`}>Modul</SvgText>
        </Svg>
      </View>
    );
  };

   /**
   * Renders the main spectrogram visualization in the *rotated* view.
   * Time axis is vertical (bottom to top), Frequency axis is horizontal (left to right).
   * Handles rendering the grid, axes, labels, and the colored rectangles representing
   * magnitude, using the pre-calculated downsampling factors and color mapping.
   * Includes touch handling via TouchableWithoutFeedback linked to `handleSpectrogramClick`.
   *
   * @returns A React Native View containing the SVG plot or a loading indicator.
   */
  const renderRotatedSpectrogram = () => {
    // Show loading indicator if data is not ready.
    if (isLoading || !spectrogramResult || spectrogramResult.times.length === 0) {
      return (<View style={{ alignItems: 'center', justifyContent: 'center', height: nonRotatedPlotHeight + svgPaddingTop + svgPaddingBottom }}> <ActivityIndicator size="large" color="white" /> <Text style={styles.loadingText}>Loading Spectrogram...</Text> </View>);
    }
    // Destructure data from the result object.
    const { spectrogram, frequencies, times, options: resultOptions } = spectrogramResult;
    // --- Get Parameters and Filter Frequencies ---
    const freqMax = resultOptions.maxFreq || 22050;
    const freqMin = resultOptions.minFreq || 0;
    const duration = resultOptions.duration ?? 0;
    const timeTicksRotated = timeTicks; // Use memoized ticks based on actualLastTime
    const freqTicksRotated = freqTicks; // Use memoized ticks based on freqMax

    // Filter frequency indices based on min/max options.
    const validFreqIndices = frequencies.map((freq, idx) => (freq >= freqMin && freq <= freqMax) ? idx : -1).filter(idx => idx !== -1);
    if (validFreqIndices.length === 0) return null; // Don't render if no frequencies are visible
    const maxFreqIndex = validFreqIndices[validFreqIndices.length - 1];
    const minFreqIndex = validFreqIndices[0];
    const numFilteredFreqBins = validFreqIndices.length;

    // --- Layout (Rotated View) ---
    // Plot dimensions - Define consistent padding
    const rotatedPaddingLeft = 55; // Space for Y axis (Time)
    const rotatedPaddingRight = 25; // Space on the right
    const rotatedPaddingTop = 20;  // Space for Title
    const rotatedPaddingBottom = 50; // Space for X axis (Frequency)

    // Calculate plot area dimensions
    const rotatedPlotWidth = Math.min(windowWidth - rotatedPaddingLeft - rotatedPaddingRight, 500); // Define plot width
    const rotatedPlotHeight = Math.min(windowWidth - 60, 400); // Keep height constraint
    const svgWidth = rotatedPlotWidth + rotatedPaddingLeft + rotatedPaddingRight;
    const svgHeight = rotatedPlotHeight + rotatedPaddingTop + rotatedPaddingBottom;

    // --- Axis Mapping Functions (Rotated View) ---
    // X-axis (Horizontal): Maps frequency index [minFreqIndex, maxFreqIndex] to pixel [0, plotWidth].
    const freqToX_rotated = (fIndex: number): number => {
      const range = maxFreqIndex - minFreqIndex;
      // Normalize index within the valid range
      const normalizedIndex = range > 0 ? (fIndex - minFreqIndex) / range : 0;
      // Map normalized index to pixel width.
      return rotatedPaddingLeft + normalizedIndex * rotatedPlotWidth;
    };

     // Y-axis (Vertical): Maps time value [0, duration] to pixel [bottom, top].
    const timeToY_rotated = (timeVal: number): number => {
      // Y=0 is top edge, Y=plotHeight is bottom edge. Time increases upwards.
      if (duration <= 0) return rotatedPaddingTop + rotatedPlotHeight / 2; 
      // Map time ratio (timeVal / duration) to inverted pixel height.
      return rotatedPaddingTop + rotatedPlotHeight - (timeVal / duration) * rotatedPlotHeight;
    };

    // --- Prepare Data for Rendering Loop ---
    // Filter frequency indices based on downsampling factor.
    const downsampledFreqIndices = validFreqIndices.filter((_, i) => i % finalFreqDownsample === 0);
    // Map original time indices (from pre-calculated `timePositions`) to their corresponding Y pixel positions.
    const timePositions_rotated = timePositions.map(tp => ({ // Use previously calculated timePositions
      y: timeToY_rotated(times[tp.timeIndex] ?? 0),
      timeIndex: tp.timeIndex
    }));

    // Calculate pixel step sizes for the *rotated* orientation rectangles.
    // Width depends on frequency spacing, Height depends on time spacing.
    const xFreqPixelStep = rotatedPlotWidth > 0 && numFilteredFreqBins > 0 ? rotatedPlotWidth / Math.ceil(numFilteredFreqBins / finalFreqDownsample) : 1;
    const yTimePixelStep = rotatedPlotHeight > 0 && times.length > 0 ? rotatedPlotHeight / Math.ceil(times.length / finalTimeDownsample) : 1;

    // --- Render SVG (Rotated) ---
    return (
      <View style={{ flexDirection: 'column', marginTop: 20 }}>
        <View style={{ marginTop: 20, marginBottom: 0 }}>
          {/* Main Title - Center based on SVG width */}
          <SvgText x={svgWidth / 2} y={rotatedPaddingTop / 2 + 5} fill="white" fontSize={16} fontWeight="bold" textAnchor="middle">
            Spectrogram
          </SvgText>
          {/* Touchable area for interaction */}
          <TouchableWithoutFeedback onPress={handleSpectrogramClick}>
            <Svg height={svgHeight} width={svgWidth} >
              {/* Background */}
              <Rect x={rotatedPaddingLeft} y={rotatedPaddingTop} width={rotatedPlotWidth} height={rotatedPlotHeight} fill="#000" />

              {/* Grid Lines - Freq (Vertical) */}
              {freqTicksRotated.map((freq, i) => {
                const freqIndex = frequencies.findIndex(f => f >= freq);
                if (freqIndex === -1 || !validFreqIndices.includes(freqIndex)) return null;
                const xPos = freqToX_rotated(freqIndex);
                return (<Line key={`vgrid-${i}`} x1={xPos} y1={rotatedPaddingTop} x2={xPos} y2={rotatedPaddingTop + rotatedPlotHeight} stroke="#333" strokeWidth="1" strokeDasharray={i === 0 ? "" : "5,5"} />);
              })}

              {/* Grid Lines - Time (Horizontal) */}
              {timeTicksRotated.map((time, i) => {
                if (duration <= 0) return null;
                const yPos = timeToY_rotated(time);
                return (<Line key={`hgrid-${i}`} x1={rotatedPaddingLeft} y1={yPos} x2={rotatedPaddingLeft + rotatedPlotWidth} y2={yPos} stroke="#333" strokeWidth="1" strokeDasharray={i === 0 ? "" : "5,5"} />);
              })}

              {/* ++ ADD: Main coordinate axes (white boundary lines) ++ */}
                <Line 
                x1={rotatedPaddingLeft}
                y1={rotatedPaddingTop}
                x2={rotatedPaddingLeft}
                y2={rotatedPaddingTop + rotatedPlotHeight}
                stroke="white"
                strokeWidth="1.5"
              />
                  <Line 
                x1={rotatedPaddingLeft}
                y1={rotatedPaddingTop + rotatedPlotHeight}
                x2={rotatedPaddingLeft + rotatedPlotWidth}
                y2={rotatedPaddingTop + rotatedPlotHeight}
                    stroke="white" 
                strokeWidth="1.5"
              />

              {/* Y Axis (Time) - Ticks and Labels */}
              {timeTicksRotated.map((time, i) => {
                if (duration <= 0) return null;
                const yPos = timeToY_rotated(time);
                return (
                  <React.Fragment key={`time-tick-label-${i}`}>
                    <Line x1={rotatedPaddingLeft - 5} y1={yPos} x2={rotatedPaddingLeft} y2={yPos} stroke="white" strokeWidth="1" />
                    <SvgText x={rotatedPaddingLeft - 8} y={yPos + 4} fill="white" textAnchor="end" fontSize="10">
                      {time < 1 ? time.toFixed(2) : time.toFixed(1)}
                    </SvgText>
                  </React.Fragment>
                );
              })}
              {/* Y Axis Title (Time) */}
                  <SvgText
                x={rotatedPaddingLeft / 2 - 10} // Adjust position for vertical axis title
                y={rotatedPaddingTop + rotatedPlotHeight / 2}
                fill="white" textAnchor="middle" fontSize={14}
                transform={`rotate(-90, ${rotatedPaddingLeft / 2 - 10}, ${rotatedPaddingTop + rotatedPlotHeight / 2})`}
              >
                Timp [s]
              </SvgText>


              {/* X Axis (Frequency) - Ticks and Labels */}
              {freqTicksRotated.map((freq, i) => {
                const freqIndex = frequencies.findIndex(f => f >= freq);
                if (freqIndex === -1 || !validFreqIndices.includes(freqIndex)) return null;
                const xPos = freqToX_rotated(freqIndex);
                return (
                  <React.Fragment key={`freq-tick-label-${i}`}>
                    <Line x1={xPos} y1={rotatedPaddingTop + rotatedPlotHeight} x2={xPos} y2={rotatedPaddingTop + rotatedPlotHeight + 5} stroke="white" strokeWidth="1" />
                    <SvgText x={xPos} y={rotatedPaddingTop + rotatedPlotHeight + 15} fill="white" textAnchor="middle" fontSize="10">
                      {freq >= 1000 ? `${freq / 1000}k` : freq.toFixed(0)}
                  </SvgText>
                </React.Fragment>
                );
              })}

              {/* X Axis Title (Frequency) */}
              <SvgText
                x={rotatedPaddingLeft + rotatedPlotWidth / 2}
                y={svgHeight - 10} // Position below ticks
                fill="white" textAnchor="middle" fontSize={14}
              >
                Frecventa [Hz]
              </SvgText>


              {/* == Waterfall Rendering Loop - Swapped Axes == */}
              {/* Iterate through downsampled time points */}
              {spectrogram.length > 0 ? (
                // Skip if time index is out of bounds (shouldn't happen)
                timePositions_rotated.map(({ y: timeY, timeIndex }) => {
                  if (timeIndex >= spectrogram.length) return null;
                  // Iterate through downsampled frequency points for this time
                  return downsampledFreqIndices.map((freqIndex) => {
                    // Skip if frequency index is out of bounds
                    if (freqIndex >= frequencies.length) return null;
                    
                    // Calculate X position based on frequency index
                    const freqX = freqToX_rotated(freqIndex); // Use new X mapping

                    // --- Averaging Logic for Downsampled Rectangles ---
                    // Calculate the average magnitude over the block of original
                    // spectrogram data points represented by this single rectangle.
                    let totalMagnitude = 0; let count = 0;
                    // Define the bounds of the original data block (time and frequency)
                    const maxT = Math.min(finalTimeDownsample, spectrogram.length - timeIndex);
                    const maxF = Math.min(finalFreqDownsample, frequencies.length - freqIndex);
                     // Iterate over the original block
                    for (let t = 0; t < maxT; t++) {
                      const row = spectrogram[timeIndex + t];
                      if (row) {
                        for (let f = 0; f < maxF; f++) {
                          const currentFreqIndex = freqIndex + f;
                          // Only include if frequency is within the valid plotted range
                          if (validFreqIndices.includes(currentFreqIndex)) {
                            const value = row[currentFreqIndex]; // Get magnitude (dB)
                            // Check if value is a valid finite number
                            if (value !== undefined && isFinite(value)) { totalMagnitude += value; count++; }
                          }
                        }
                      }
                    }
                    // Calculate average magnitude (or default to low value if no valid data)
                    const averageMagnitude = count > 0 ? totalMagnitude / count : -160;
                    // --- End Averaging Logic ---

                    // Use calculated pixel step sizes for rectangle dimensions
                    const rectWidth = Math.max(1, xFreqPixelStep);
                    const rectHeight = Math.max(1, yTimePixelStep);

                    // Render the rectangle
            return (
              <Rect
                        key={`${timeIndex}-${freqIndex}`}  // Unique key
                        x={freqX} // X position based on frequency
                        y={timeY - rectHeight} // Y position based on time (adjust for rect height as Y=0 is top)
                        width={rectWidth}
                        height={rectHeight}
                        fill={getColorMemoized(averageMagnitude)} // Fill with calculated color
                      />
                    );
                  }).filter(Boolean); // Filter out any nulls from skipped indices
                })
              ) : null /* End of main rendering loop */ }
              {/* == End Waterfall Rendering Loop == */}

              {/* Selection Indicator (Horizontal Line in Rotated View) */}
              {/* Rendered if selection is visible and has valid Y position */}
              {selectionRect.visible && selectionRect.y != null && selectionRect.height != null && (
                <Rect
                  x={selectionRect.x} // Starts at left plot edge
                  y={selectionRect.y} // Y position calculated in handleSpectrogramClick
                  width={rotatedPlotWidth} // Spans plot width
                  height={selectionRect.height} // Thickness of the line
                  fill="none" stroke="#00ff00" strokeWidth={1} // Thinner stroke for line
                />
        )}
      </Svg>
          </TouchableWithoutFeedback>

          {/* Color Scale Legend (Rotated View) */}
          {/* Positioned below the main plot */}
          <View style={[styles.colorScale, { marginTop: 10, marginBottom: 20, marginHorizontal: rotatedPaddingLeft, width: rotatedPlotWidth }]}>
            {/* Label for minimum value of dynamic range */}
            <Text style={styles.colorScaleLabel}>-{options.dynamicRange ?? 50} dB</Text>
             {/* The color bar itself */}
          <View style={styles.colorBar}>
               {/* Generate 100 small colored segments to form the gradient */}
              {Array.from({ length: 100 }).map((_, i) => (<View key={i} style={[styles.colorBarSegment, { backgroundColor: getColorFromMagnitude(-(options.dynamicRange ?? 50) + (i * (options.dynamicRange ?? 50)) / 100, options.dynamicRange ?? 50, colorMap) },]} />))}
          </View>
            {/* Label for maximum value (0 dB) */}
          <Text style={styles.colorScaleLabel}>0 dB</Text>
          </View>
        </View>
    </View>
    );
  };

  /**
   * Renders the dynamic range slider control.
   * Allows the user to adjust the range of dB values mapped to the color scale.
   *
   * @returns A React Native View containing the slider and label.
   */
  const renderDynamicRangeSlider = () => {
    return (
      <View style={styles.controlRow}>
        {/* Label displaying the current dynamic range value */}
        <Text style={styles.controlLabel}>Dyn Range: {options.dynamicRange ?? 50}dB</Text> {/* Label shows current options state */}
        <Slider
          style={{ width: 180, height: 40 }}
          minimumValue={20} // Min possible range (e.g., 20 dB)
          maximumValue={120} // Max possible range (e.g., 120 dB)
          step={5} // Step size for the slider
          value={options.dynamicRange} // Slider controls the options state directly
          // Update the dynamicRange in the options state when slider value changes
          onValueChange={(value) => setOptions(prev => ({ ...prev, dynamicRange: value }))}
          minimumTrackTintColor="#FFFFFF"
          maximumTrackTintColor="#000000" // Use slightly lighter gray for max track
          disabled={isLoading} // Disable while loading
        />
      </View>
    );
  };

  // --- Main Return JSX ---
  return (
    <ScrollView style={styles.container}>
      {/* Removed extra wrapping View */}
      {/* Header Section */}
      <View>
        {/* Header Buttons: Rotate, Controls Toggle, Export */}
        <View style={styles.header}>
          <View style={styles.headerButtons}>
            {/* Rotate Button: Toggles between horizontal and vertical spectrogram */}
            <Button title="Rotate" onPress={() => setIsRotated(!isRotated)} disabled={isLoading} />
            {/* Filter Toggle Button */}
            <Button 
              title={isFilterEnabled ? "Filter: ON" : "Filter: OFF"}
              onPress={() => {
                // Toggles the 'isFilterEnabled' state.
                setIsFilterEnabled(!isFilterEnabled);
                // Add this line to clear the existing result, forcing regeneration
                // When the filter state changes, the spectrogram result is cleared.
                // This ensures that the spectrogram generation effect (useEffect)
                // re-runs and uses the new 'filteredSamples' (or raw samples if filter is off),
                // thus updating the displayed spectrogram.
                setSpectrogramResult(null);
              }}
              disabled={isLoading}
              color={isFilterEnabled ? '#4CAF50' : '#f44336'} // Green when ON, Red when OFF
            />
            {/* Show/Hide Controls Button */}
            <Button title={showControls ? "Hide Controls" : "Show Controls"} onPress={() => setShowControls(!showControls)} disabled={isLoading} />
            {/* Export Data Button */}
            <Button title="Export Data" onPress={handleExport} disabled={isLoading} />
          </View>
        </View>

        {/* Controls Panel (Conditionally Rendered) */}
        {showControls && (
          <View style={styles.controls}>
            {/* Window Type */}
            <View style={styles.controlRow}>
              <Text style={styles.controlLabel}>Window Type:</Text>
              {/* Use ScrollView for horizontal button list */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {['hanning', 'hamming', 'blackman', 'bartlett', 'rectangular'].map((type) => (
                  <Button
                    key={type} title={type}
                    onPress={() => setOptions({ ...options, windowType: type as WindowType })} // Update options directly
                    color={options.windowType === type ? '#4CAF50' : '#2196F3'}
                    disabled={isLoading}
                  />
                ))}
              </ScrollView>
            </View>
            {/* Color Map */}
            <View style={styles.controlRow}>
              <Text style={styles.controlLabel}>Color Map:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {['viridis', 'magma', 'plasma', 'inferno', 'grayscale'].map((map) => (
                  <Button
                    key={map} title={map}
                    onPress={() => setColorMap(map as ColorMap)}
                    color={colorMap === map ? '#4CAF50' : '#2196F3'}
                    disabled={isLoading}
                  />
                ))}
              </ScrollView>
            </View>
            {/* Dynamic Range */}
            {renderDynamicRangeSlider()} 

            {/* FFT Size */}
            <View style={styles.controlRow}>
              <Text style={styles.controlLabel}>FFT Size:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {[512, 1024, 2048, 4096].map((size) => (
                  <Button
                    key={size} title={size.toString()}
                    onPress={() => setOptions({ ...options, fftSize: size })}
                    color={options.fftSize === size ? '#4CAF50' : '#2196F3'}
                    disabled={isLoading}
                  />
                ))}
              </ScrollView>
            </View>

            {/* Overlap */}
            <View style={styles.controlRow}>
              <Text style={styles.controlLabel}>Overlap: {((options.overlap || 0.75) * 100).toFixed(0)}%</Text>
              <Slider
                style={{ width: 180, height: 40 }} // Slightly reduced width
                minimumValue={0} maximumValue={0.95} step={0.05}
                value={options.overlap || 0.75}
                onValueChange={(value: number) => setOptions(prev => ({ ...prev, overlap: value }))} // Update directly
                minimumTrackTintColor="#FFFFFF" maximumTrackTintColor="#000000"
                disabled={isLoading}
              />
            </View>
          </View>
        )}

        {/* Loading Indicator Section */}
        {/* Show overlay ONLY if actively loading OR if inputs exist but result doesn't yet */}
        {(isLoading || (!spectrogramResult && (rawSamplesString || audioMeteringString))) && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.loadingText}>Generating Spectrogram...</Text>
                </View>
        )}

        {/* "No Data" Message Section */}
        {/* Show message if not loading, no result exists, AND no input strings were provided */}
        {!isLoading && !spectrogramResult && !rawSamplesString && !audioMeteringString && (
          <Text style={styles.errorText}>No spectrogram data generated. Check input or options.</Text>
        )}

        {/* Main Spectrogram Display Area */}
        {/* Render the appropriate view ONLY if NOT loading AND a result exists */}
        {!isLoading && spectrogramResult && (
          <> {/* Wrap conditional rendering sections */}
            {(currentTimes.length > 0) && !isRotated && (
              // --- Non-Rotated View with Horizontal Scroll ---          
              <Animated.ScrollView
                key={`nonrotated-${uri || 'no-uri'}`} // Key to force remount if URI changes
                horizontal={true}
                style={styles.spectrogramContainer}
                contentContainerStyle={{ width: nonRotatedPlotWidth + svgPaddingLeft + svgPaddingRight }} // Set content width for scrolling
                showsHorizontalScrollIndicator={true}
                onScroll={scrollHandler} // Attach animated scroll handler
                scrollEventThrottle={16} // Fire scroll events frequently for smooth tracking
              >
                {/* SVG-based rendering for Non-Rotated View */}
                {/* Calculate dimensions and mappings needed inside the SVG */}
                {isLoading || currentTimes.length > 0 ? ( // Render SVG container if loading or data exists
                  <Svg
                    height={nonRotatedPlotHeight + svgPaddingTop + svgPaddingBottom}
                    width={nonRotatedPlotWidth + svgPaddingLeft + svgPaddingRight}
                  >
                    {/* Background */}
                    <Rect x={svgPaddingLeft} y={svgPaddingTop} width={nonRotatedPlotWidth} height={nonRotatedPlotHeight} fill="#000" />

                    {/* Render Grid, Axes, Labels, and Spectrogram Data if NOT loading and data exists */}
                    {!isLoading && currentTimes.length > 0 && currentFrequencies.length > 0 && (() => {
                      const validFreqIndices = currentFrequencies
                        .map((freq, idx) => freq >= (currentOptions.minFreq ?? 0) && freq <= (currentOptions.maxFreq || 22050) ? idx : -1)
                        .filter(idx => idx !== -1);

                      if (validFreqIndices.length === 0) return null; // Don't render if no valid freqs

                      const maxFreqIndex = validFreqIndices[validFreqIndices.length - 1];
                      const minFreqIndex = validFreqIndices[0];
                      const numFilteredFreqBins = validFreqIndices.length;

                      // Mapping Functions (Non-Rotated)
                      const timeToX_nonRotated = (timeVal: number): number => {
                        if (actualLastTime <= 0) return svgPaddingLeft;
                        return svgPaddingLeft + (timeVal / actualLastTime) * nonRotatedPlotWidth;
                      };
                      const freqToY_nonRotated = (fIndex: number): number => {
                        const range = maxFreqIndex - minFreqIndex;
                        if (range <= 0) return svgPaddingTop + nonRotatedPlotHeight / 2; 
                        const normalizedIndex = (fIndex - minFreqIndex) / range;
                        // Y=0 is top, high frequency (large index) should be at the top (low Y value)
                        return svgPaddingTop + nonRotatedPlotHeight - normalizedIndex * nonRotatedPlotHeight;
                      };

                      // Filter frequencies based on downsampling factor
                      const downsampledFreqIndices = validFreqIndices.filter((_, i) => i % finalFreqDownsample === 0);

                      return (
                        <React.Fragment>
                          {/* Grid Lines - Time (Vertical) */}
                          {timeTicks.map((time, i) => {
                            const xPos = timeToX_nonRotated(time);
                            // Optimization: Render only grid lines within the current plot bounds
                            if (xPos < svgPaddingLeft || xPos > svgPaddingLeft + nonRotatedPlotWidth) return null;
                            return (<Line key={`vgrid-nr-${i}`} x1={xPos} y1={svgPaddingTop} x2={xPos} y2={svgPaddingTop + nonRotatedPlotHeight} stroke="#333" strokeWidth="1" strokeDasharray={i === 0 ? "" : "5,5"} />);
                          })}

                          {/* Grid Lines - Freq (Horizontal) */}
                          {freqTicks.map((freq, i) => {
                            const freqIndex = currentFrequencies.findIndex(f => f >= freq);
                            if (freqIndex === -1 || !validFreqIndices.includes(freqIndex)) return null;
                            const yPos = freqToY_nonRotated(freqIndex);
                            return (<Line key={`hgrid-nr-${i}`} x1={svgPaddingLeft} y1={yPos} x2={svgPaddingLeft + nonRotatedPlotWidth} y2={yPos} stroke="#333" strokeWidth="1" strokeDasharray={i === 0 ? "" : "5,5"} />);
                          })}

                          {/* Main coordinate axes (white boundary lines) */}
                          <Line x1={svgPaddingLeft} y1={svgPaddingTop} x2={svgPaddingLeft} y2={svgPaddingTop + nonRotatedPlotHeight} stroke="white" strokeWidth="1.5" />
                          <Line x1={svgPaddingLeft} y1={svgPaddingTop + nonRotatedPlotHeight} x2={svgPaddingLeft + nonRotatedPlotWidth} y2={svgPaddingTop + nonRotatedPlotHeight} stroke="white" strokeWidth="1.5" />

                          {/* Y Axis (Frequency) - Ticks and Labels */}
                          {freqTicks.map((freq, i) => {
                            const freqIndex = currentFrequencies.findIndex(f => f >= freq);
                            if (freqIndex === -1 || !validFreqIndices.includes(freqIndex)) return null;
                            const yPos = freqToY_nonRotated(freqIndex);
                            const label = freq < 1000 ? `${Math.round(freq)}` : `${(freq / 1000).toFixed(1)}k`;
                            return (
                              <React.Fragment key={`freq-tick-label-nr-${i}`}>
                                <Line x1={svgPaddingLeft - 5} y1={yPos} x2={svgPaddingLeft} y2={yPos} stroke="white" strokeWidth="1" />
                                <SvgText x={svgPaddingLeft - 8} y={yPos + 4} fill="white" textAnchor="end" fontSize="10">{label}</SvgText>
                              </React.Fragment>
                            );
                          })}

                          {/* Y Axis Title (Frequency) */}
                          <SvgText
                            x={svgPaddingLeft / 2 - 10}
                            y={svgPaddingTop + nonRotatedPlotHeight / 2}
                            fill="white" textAnchor="middle" fontSize={14}
                            transform={`rotate(-90, ${svgPaddingLeft / 2 - 10}, ${svgPaddingTop + nonRotatedPlotHeight / 2})`}
                          > Frecventa [Hz] </SvgText>

                          {/* X Axis (Time) - Ticks and Labels */}
                          {timeTicks.map((time, i) => {
                            const xPos = timeToX_nonRotated(time);
                            if (xPos < svgPaddingLeft - 1 || xPos > svgPaddingLeft + nonRotatedPlotWidth + 1) return null; // Allow slight overshoot for labels
                            const label = time.toFixed(time < 1 ? 2 : 1);
                            return (
                              <React.Fragment key={`time-tick-label-nr-${i}`}>
                                <Line x1={xPos} y1={svgPaddingTop + nonRotatedPlotHeight} x2={xPos} y2={svgPaddingTop + nonRotatedPlotHeight + 5} stroke="white" strokeWidth="1" />
                                <SvgText x={xPos} y={svgPaddingTop + nonRotatedPlotHeight + 15} fill="white" textAnchor="middle" fontSize="10">{label}</SvgText>
                              </React.Fragment>
                            );
                          })}

                          {/* X Axis Title (Time) */}
                          <SvgText
                            x={svgPaddingLeft + nonRotatedPlotWidth / 2}
                            y={svgPaddingTop + nonRotatedPlotHeight + svgPaddingBottom - 5} 
                            fill="white" textAnchor="middle" fontSize={14}
                          > Timp [s] </SvgText>

                          {/* Spectrogram Rectangles */}
                          {/* Iterate through downsampled time positions */}
                          {timePositions.map(({ x: timeXBase, timeIndex }) => { // x from timePositions is pre-downsampled, recalculate exact pos
                            if (timeIndex >= currentTimes.length) return null;
                            const timeValue = currentTimes[timeIndex] ?? 0;
                            // Calculate exact X position based on the actual time value
                            const finalTimeX = timeToX_nonRotated(timeValue);
                            
                            // Iterate through downsampled frequency indices
                            return downsampledFreqIndices.map((freqIndex) => {
                              if (freqIndex >= currentFrequencies.length) return null;
                              // Calculate Y position based on frequency index
                              const freqY = freqToY_nonRotated(freqIndex);

                              // Averaging Logic (same as before)
                              let totalMagnitude = 0; let count = 0;
                              const maxT = Math.min(finalTimeDownsample, currentTimes.length - timeIndex);
                              const maxF = Math.min(finalFreqDownsample, currentFrequencies.length - freqIndex);
                              for (let t = 0; t < maxT; t++) {
                                const row = spectrogramResult?.spectrogram[timeIndex + t];
                          if (row) {
                                  for (let f = 0; f < maxF; f++) {
                                    const currentFreqIndex = freqIndex + f;
                                    if (validFreqIndices.includes(currentFreqIndex)) {
                                      const value = row[currentFreqIndex];
                                      if (value !== undefined && isFinite(value)) { totalMagnitude += value; count++; }
                                    }
                                  }
                                }
                              }
                        const averageMagnitude = count > 0 ? totalMagnitude / count : -160;
                              // --- End Averaging Logic ---

                              // Use pixel step sizes calculated earlier
                              const rectWidth = Math.max(1, xPixelStepFinal);
                              const rectHeight = Math.max(1, yPixelStepFinal);
                              // Get color for the average magnitude
                              const color = getColorMemoized(averageMagnitude);
                              
                              // Render the rectangle
                        return (
                          <Rect
                                  key={`${timeIndex}-${freqIndex}-nr`}
                                  x={finalTimeX} 
                                  y={freqY - rectHeight} 
                                  width={rectWidth}
                                  height={rectHeight}
                                  fill={color}
                                />
                              );
                            }).filter(Boolean);  // Filter nulls
                          }).flat().filter(Boolean)} 
                        </React.Fragment>
                      );
                    })()}
                  </Svg>
                ) : null}
              </Animated.ScrollView> // Closing ScrollView for non-rotated view
            )} 

            {/* Rotated View - Direct conditional rendering */}
            {isRotated && (
              <View> {/* Add a wrapping View for rotated plots */}
                {/*Render segment plots ONLY if a time index is selected*/}
                {selectedTimeIndex !== null && (
                  <>
                    {renderSegmentTimeDomain()}
                    {renderSpectrum()}
                  </>
                )}

                {/* Render main rotated spectrogram */}
                {(isLoading || currentTimes.length > 0)
                  ? renderRotatedSpectrogram() // Call the function directly
                  : (<View style={{ alignItems: 'center', justifyContent: 'center', padding: 20, height: nonRotatedPlotHeight + svgPaddingTop + svgPaddingBottom }}><Text style={styles.loadingText}>Preparing...</Text></View>)
                }
              </View> // Closing wrapping View
            )}

            {/* Color Scale - Render only when not generating and data exists */}
            {!isRotated && !isLoading && currentTimes.length > 0 && (
              <View style={[styles.colorScale, { marginTop: 10, marginBottom: 20, marginHorizontal: svgPaddingLeft, width: nonRotatedPlotWidth * 0.8, alignSelf: 'center' }]}> {/* Reduced width to 80% & kept alignSelf */}
                {/* Use options.dynamicRange for immediate update*/}
                <Text style={styles.colorScaleLabel}>-{options.dynamicRange ?? 50} dB</Text>
                <View style={styles.colorBar}>
                  {Array.from({ length: 100 }).map((_, i) => {
                    const dynamicRangeToUse = options.dynamicRange ?? 50;
                    const dbValue = -dynamicRangeToUse + (i * dynamicRangeToUse) / 100;
                    return (
                      <View key={i} style={[styles.colorBarSegment, { backgroundColor: getColorFromMagnitude(dbValue, dynamicRangeToUse, colorMap) },]} />
                    );
                  })}
                </View>
                <Text style={styles.colorScaleLabel}>0 dB</Text>
              </View>
            )}

            {/* Render other plots only when not generating */}
            {/* Time Domain Plot of Selected Segment */}
            {!isLoading && currentTimes.length > 0 && renderFullSpectrum()}
            {/* Frequency Spectrum Plot of Selected Segment */}
            {!isLoading && currentTimes.length > 0 && renderTimeDomain}
          </> 
        )}
    </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000', // Black background for the entire screen
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginVertical: 20,
  },
  controls: {
    padding: 20,
    backgroundColor: '#222',
    marginHorizontal: 10,
    borderRadius: 10,
    marginBottom: 20,
  },
  controlLabel: {
    color: 'white',
    fontSize: 14,
    marginVertical: 5,
  },
  spectrogramContainer: {
    flexDirection: 'row',
    marginHorizontal: 10,
    marginBottom: 50,
  },
  errorText: {
    color: 'red',
    textAlign: 'center',
    marginTop: 50,
  },
  colorScale: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 10,
  },
  colorScaleLabel: {
    color: 'white',
    fontSize: 12,
    marginHorizontal: 10,
  },
  colorBar: {
    flexDirection: 'row',
    height: 20,
    flex: 1,
  },
  colorBarSegment: {
    flex: 1,
    height: '100%',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center', // Added to center the buttons horizontally
    width: '100%', // Added to ensure the buttons take full width of the header
  },
  fullSpectrumContainer: {
    marginHorizontal: 10,
    marginTop: 20,
    marginBottom: 20,
    padding: 10,
    backgroundColor: '#111',
    borderRadius: 5,
  },
  fullSpectrumTitle: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  plotTitle: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 5,
    paddingHorizontal: 10,
  },
  timeDomainContainer: {
    marginHorizontal: 10,
    marginTop: 20,
    marginBottom: 20,
    padding: 10,
    backgroundColor: '#111',
    borderRadius: 5,
  },
  loadingText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 20,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
    minHeight: 200,
  },
});

export default SpectrogramScreen;

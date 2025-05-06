import FFT from "fft.js";

// --- Window Functions ---
// Creates a windowing function array of a specified type and length.
// Windowing functions are applied to audio frames before FFT to reduce spectral leakage.
export const createWindow = (length: number, type: WindowType): Float32Array => {
  const window = new Float32Array(length);
  
  switch (type) {
    case 'hanning':
      // Hanning window formula.
      for (let i = 0; i < length; i++) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
      }
      break;
    
    case 'hamming':
      // Hamming window formula.
      for (let i = 0; i < length; i++) {
        window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1));
      }
      break;
    
    case 'blackman':
      // Blackman window formula.
      for (let i = 0; i < length; i++) {
        const x = (2 * Math.PI * i) / (length - 1);
        window[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
      }
      break;
    
    case 'bartlett':
      // Bartlett (triangular) window formula.
      for (let i = 0; i < length; i++) {
        window[i] = 2 / (length - 1) * ((length - 1) / 2 - Math.abs(i - (length - 1) / 2));
      }
      break;
    
    case 'rectangular':
    default:
      // Rectangular window (no windowing) - all values are 1.
      window.fill(1);
      break;
  }
  
  return window;
};

// --- Scale Conversions ---
// Converts a decibel (dB) value to a linear amplitude/power scale.
const dbToLinear = (db: number): number => {
  // Avoids issues with -Infinity dB.
  if (db <= -160) return 0;
  return Math.pow(10, db / 20);
};

// Converts a linear amplitude/power value to decibels (dB).
const linearToDb = (linear: number): number => {
  // Avoid Math.log10(0) or negative values which result in NaN or -Infinity.
  // Use a small epsilon (1e-10, approx -200 dB) as the floor.
  return 20 * Math.log10(Math.max(linear, 1e-10));
};

// --- Type Definitions ---
// Supported window function types.
export type WindowType = 'hanning' | 'hamming' | 'blackman' | 'bartlett' | 'rectangular';
// Supported frequency scale types (currently only linear is fully used in calculations).
export type ScaleType = 'linear' | 'log';
// Supported color map types for spectrogram visualization.
export type ColorMapType = 'viridis' | 'magma' | 'plasma' | 'inferno' | 'grayscale';

// Interface defining the options for spectrogram generation.
export interface SpectrogramOptions {
  samplingRate?: number; // Audio sample rate in Hz (e.g., 44100).
  fftSize?: number; // Size of the Fast Fourier Transform window (power of 2 recommended).
  overlap?: number; // Overlap ratio between consecutive FFT windows (0 to < 1).
  windowType?: WindowType; // Type of window function to apply before FFT.
  scaleType?: ScaleType; // Frequency scale (linear or logarithmic) - affects axis rendering.
  minFreq?: number; // Minimum frequency to display (Hz).
  maxFreq?: number; // Maximum frequency to display (Hz).
  dynamicRange?: number; // Dynamic range in dB for color mapping.
  duration?: number; // Estimated or known duration of the audio in seconds.
  sineWaveFrequency?: number; // Optional: Exact frequency if the input is known to be a sine wave.
  colorMap?: ColorMapType; // Color map to use for visualization.
}

// --- Core Spectrum Calculation ---
// Calculates the magnitude spectrum for a single frame (window) of audio data.
export const calculateSpectrum = (
  audioSamples: Float32Array, // Input audio samples for this frame.
  options: SpectrogramOptions = {} // Spectrogram options.
) => {
  const {
    samplingRate = 44100,
    fftSize = 1024,
    windowType = 'hanning',
  } = options;

  // Ensure the input frame matches the FFT size, pad with zeros if needed.
  let frame = audioSamples;
  if (frame.length < fftSize) {
    const paddedFrame = new Float32Array(fftSize).fill(0);
    paddedFrame.set(frame);
    frame = paddedFrame;
  } else if (frame.length > fftSize) {
    // Truncate if longer (should ideally not happen with correct framing logic).
    frame = frame.slice(0, fftSize);
  }

  // Apply the selected window function to the frame.
  const window = createWindow(fftSize, windowType);
  const windowedFrame = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    windowedFrame[i] = frame[i] * window[i];
  }

  // Perform FFT using the fft.js library.
  const fft = new FFT(fftSize);
  const complexInput = fft.createComplexArray(); // Array for interleaved real/imaginary input.
  const complexOutput = fft.createComplexArray(); // Array for interleaved real/imaginary output.

  // Prepare the complex input array (real part = windowed samples, imaginary part = 0).
  for (let i = 0; i < fftSize; i++) {
    complexInput[2 * i] = windowedFrame[i];
    complexInput[2 * i + 1] = 0;
  }

  // Execute the FFT transform.
  fft.transform(complexOutput, complexInput);

  // Calculate the magnitude spectrum from the complex FFT output.
  // Only the first half (0 to N/2) is needed due to symmetry for real inputs.
  const Np2 = Math.floor(fftSize/2);
  const spectrum = new Array(Np2); // Array to store magnitude values.
  
  // Calculate the frequency corresponding to each bin.
  const delta_f = samplingRate/fftSize;  // Frequency resolution (Hz per bin).
  const frequencies = new Array(Np2); // Array to store frequency values.
  
  for (let k = 0; k < Np2; k++) {
    const re = complexOutput[2 * k]; // Real part.
    const im = complexOutput[2 * k + 1]; // Imaginary part.
    // Calculate magnitude: sqrt(re^2 + im^2). Direct linear magnitude, not dB.
    spectrum[k] = Math.sqrt(re * re + im * im);
    // Calculate frequency for this bin.
    frequencies[k] = k * delta_f;
  }

  // Return the calculated linear magnitude spectrum and corresponding frequencies.
  return {
    spectrum,
    frequencies,
    delta_f, // Also return frequency resolution if needed elsewhere.
  };
};

// Callback type definition (currently unused as generation is synchronous).
// export type SpectrogramChunkCallback = (chunk: { spectrogramChunk: number[][]; timesChunk: number[] }) => void;

// --- Main Spectrogram Generation Function ---
// Generates the full spectrogram data from audio input.
export const generateSpectrogram = async (
  audioInput: number[] | Float32Array, // Can be raw PCM samples (Float32Array) or dB metering data (number[]).
  options: SpectrogramOptions = {} // Spectrogram options.
): Promise<{ // Returns a Promise resolving to the spectrogram result.
  spectrogram: number[][]; // The 2D array of dB magnitudes [time][frequency].
  times: number[]; // Array of time points for each frame.
  frequencies: number[]; // Array of frequency points for each bin.
  options: SpectrogramOptions; // The options used, including calculated duration.
}> => {
  // Destructure options with defaults.
  const {
    samplingRate = 44100,
    fftSize = 1024,
    overlap = 0.75,
    windowType = 'hanning',
    // scaleType = 'linear', // scaleType currently only affects rendering, not generation.
    // minFreq = 0,          // Filtering by min/max freq happens during rendering.
    // maxFreq = samplingRate / 2,
    // dynamicRange = 115,   // dynamicRange only affects rendering.
    // duration            // Duration is recalculated from input data.
  } = options;

  let audioSamples: Float32Array;

  // --- Input Data Validation and Preparation ---
  // Check for empty or invalid input.
  if (!audioInput || 
      (Array.isArray(audioInput) && audioInput.length === 0) || 
      (audioInput instanceof Float32Array && audioInput.length === 0)) {
    console.error("Invalid empty input for spectrogram generation");
    throw new Error("Invalid empty input data");
  }

  console.log(`Input type: ${audioInput instanceof Float32Array ? 'Float32Array (raw samples)' : 'Array (metering)'}`);
  console.log(`Input length: ${audioInput.length}`);
  console.log(`Sample rate: ${samplingRate}, FFT size: ${fftSize}, Overlap: ${overlap}`);
  
  // If input is raw PCM samples, use it directly.
  if (audioInput instanceof Float32Array) {
    console.log("Generating spectrogram from raw samples");
    audioSamples = audioInput;
  } else {
    // If input is an array, assume it's dB metering data.
    console.log("Generating spectrogram from dB metering data (fallback)");
    // Convert dB metering data back to linear amplitude (this is an approximation).
    // First, check for invalid values (NaN, null, -Infinity).
    const hasInvalidValues = audioInput.some(value => value === undefined || value === null || isNaN(value) || value === -Infinity);
    if (hasInvalidValues) {
      console.warn("Input metering data contains invalid values, replacing with -160dB");
    }
    // Convert valid dB values to linear, replace invalid ones with silence (0 linear).
    audioSamples = new Float32Array(audioInput.map(db => {
      if (db === undefined || db === null || isNaN(db) || db === -Infinity) {
        return dbToLinear(-160); // Treat invalid as silence.
      } else {
        // Clamp dB values before converting to avoid extreme linear values.
        return dbToLinear(Math.max(-160, Math.min(0, db)));
      }
    }));
  }

  console.log("Processed input data length for spectrogram calculation:", audioSamples.length);

  // Ensure we have enough samples for at least one FFT window.
  // Pad with zeros if the audio sample array is shorter than the FFT size.
  if (audioSamples.length < fftSize) {
    const originalLength = audioSamples.length;
    const paddedSamples = new Float32Array(fftSize).fill(0); // Create zero-filled array.
    paddedSamples.set(audioSamples); // Copy original samples to the beginning.
    audioSamples = paddedSamples;
    console.warn(`Padded audio samples from ${originalLength} to ${fftSize} to allow FFT.`);
  }
  // --- End Input Data Preparation ---

  // --- Spectrogram Calculation Setup ---
  // Calculate hop size: the number of samples to advance between consecutive frames.
  const hopSize = Math.floor(fftSize * (1 - overlap));
  // Calculate the total number of time frames based on samples, FFT size, and hop size.
  const totalTimeFrames = Math.max(1, Math.floor((audioSamples.length - fftSize) / hopSize) + 1);
  // Calculate the actual duration of the audio based on the number of samples and sample rate.
  const actualDuration = audioSamples.length / samplingRate;
  console.log(`Calculated total time frames: ${totalTimeFrames}, Actual Duration: ${actualDuration.toFixed(3)}s`);

  // Calculate the frequency axis once using the first frame.
  // Assumes frequency axis remains constant.
  const { frequencies } = calculateSpectrum(audioSamples.slice(0, fftSize), { ...options, samplingRate });

  // Initialize arrays to store the full results.
  const fullSpectrogram: number[][] = []; // Stores dB magnitude values for each frame.
  const fullTimes: number[] = []; // Stores the center time for each frame.

  // --- Frame Processing Loop ---
  // Iterate through the audio samples, creating overlapping frames.
  for (let i = 0; i < totalTimeFrames; i++) {
    const frameStart = i * hopSize; // Starting sample index for the current frame.
    // Ensure the frame doesn't extend beyond the audio sample buffer.
    if (frameStart + fftSize > audioSamples.length) {
      // This can happen if the last frame is incomplete due to integer division in totalTimeFrames calculation.
      // Option 1: Skip incomplete frame (as done here).
      // Option 2: Pad the last frame with zeros.
      console.warn(`Skipping potentially incomplete frame at index ${i} (start: ${frameStart}, needed: ${fftSize}, available: ${audioSamples.length - frameStart})`);
      continue; 
    }
    // Extract the audio samples for the current frame.
    const frame = audioSamples.slice(frameStart, frameStart + fftSize);
    // Calculate the linear magnitude spectrum for this frame.
    const { spectrum } = calculateSpectrum(frame, { ...options, samplingRate });
    
    // Convert the linear magnitudes to the dB scale for storage/visualization.
    const magnitudesDb = spectrum.map(mag => linearToDb(mag));
    // Add the dB spectrum of this frame to the full spectrogram array.
    fullSpectrogram.push(magnitudesDb);
    
    // Calculate the time corresponding to the center of this frame.
    // Time = (frame index / total frames) * total duration
    // Using (totalTimeFrames - 1) as denominator scales correctly from 0 to actualDuration.
    const time = totalTimeFrames > 1 ? (i / (totalTimeFrames - 1)) * actualDuration : actualDuration / 2; 
    // Add the calculated time to the times array.
    fullTimes.push(time);
  }
  // --- End Frame Processing Loop ---

  console.log(`Finished generating spectrogram data. Total frames processed: ${fullSpectrogram.length}`);

  // Return the complete spectrogram data, time/frequency axes, and updated options.
  return {
    spectrogram: fullSpectrogram,
    times: fullTimes,
    frequencies,
    options: {
      ...options, // Include original options passed in.
      duration: actualDuration // Ensure the accurate calculated duration is returned.
    },
  };
};

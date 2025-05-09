/**
 * Applies an IIR (Infinite Impulse Response) filter to a set of audio samples.
 * This implementation uses the Direct Form I difference equation:
 *
 *   y[n] = (1/a[0]) * (SUM_{k=0 to M} b[k]*x[n-k] - SUM_{k=1 to N} a[k]*y[n-k])
 *
 * where:
 * - y[n] is the output sample at time n
 * - x[n] is the input sample at time n
 * - b[k] are the numerator (feedforward) coefficients
 * - a[k] are the denominator (feedback) coefficients
 * - M is the order of the numerator polynomial
 * - N is the order of the denominator polynomial
 *
 * @param samples The input audio samples (Float32Array).
 * @param b The numerator coefficients (feedforward part).
 * @param a The denominator coefficients (feedback part).
 *          It's crucial that a[0] is 1.0 for this implementation if direct division is not applied.
 *          If a[0] is not 1.0, all 'a' and 'b' coefficients should be pre-normalized by dividing by a[0],
 *          or the implementation should explicitly divide by a[0] at each step.
 * @returns A new Float32Array containing the filtered audio samples.
 */
export function applyIIRFilter(
  samples: Float32Array,
  b: number[],
  a: number[]
): Float32Array {
  // M is the order of the numerator polynomial (number of b coefficients).
  const M = b.length;
  // N is the order of the denominator polynomial (number of a coefficients).
  const N = a.length;
  // Create a new array to store the filtered output samples.
  // It has the same length as the input samples array.
  const filteredSamples = new Float32Array(samples.length);

  // Get the first denominator coefficient a[0].
  // If a[0] is 0 or undefined, default to 1 to prevent division by zero.
  const a0 = a[0] || 1; 
  // If a[0] is not 1, it means the filter coefficients are not normalized.
  // The standard Direct Form I implementation assumes a[0] is 1.
  // If it's not, we must divide the entire result by a[0] at each step.
  // A warning is logged as pre-normalizing coefficients is often more efficient.
  if (a0 !== 1) {
    console.warn(
      `applyIIRFilter: a[0] (${a0}) is not 1. ` +
      `The filter calculation will divide by a[0] at each step. ` +
      `For better performance or standard practice, consider normalizing coefficients beforehand.`
    );
  }

  // Iterate over each input sample to calculate the corresponding output sample.
  for (let n = 0; n < samples.length; n++) {
    let feedforwardSum = 0;
    // Calculate the feedforward part of the filter equation:
    // SUM_{k=0 to M-1} b[k]*x[n-k]
    // This sums the current and past input samples, weighted by 'b' coefficients.
    for (let k = 0; k < M; k++) {
      // Ensure we don't access samples at negative indices (before the signal starts).
      if (n - k >= 0) {
        feedforwardSum += b[k] * samples[n - k];
      }
    }

    let feedbackSum = 0;
    // Calculate the feedback part of the filter equation:
    // SUM_{k=1 to N-1} a[k]*y[n-k]
    // This sums the past output samples, weighted by 'a' coefficients (excluding a[0]).
    // Note: The loop starts from k=1 because a[0] is handled separately by division.
    for (let k = 1; k < N; k++) { // Starts from k=1
      // Ensure we don't access filtered samples at negative indices.
      if (n - k >= 0) {
        feedbackSum += a[k] * filteredSamples[n - k];
      }
    }
    // Apply the full difference equation:
    // y[n] = (feedforwardSum - feedbackSum) / a[0]
    filteredSamples[n] = (feedforwardSum - feedbackSum) / a0;
  }

  return filteredSamples;
} 
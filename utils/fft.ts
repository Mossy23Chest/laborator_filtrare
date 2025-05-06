import FFTBase from 'fft.js';

export class FFT extends FFTBase {
    createComplexArray(): number[] {
        const arr = new Float32Array(this.size * 2);
        return Array.from(arr);
    }
}

// Convert dB to linear scale
export const dbToLinear = (db: number): number => {
    return Math.pow(10, db / 20);
}; 
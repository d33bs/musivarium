import type { Pixels, Region } from '../core';
import type { Alignment, NgffMetadata, NetworkStats, PlaneRequest } from './metadata';
export interface ImageSource {
  readonly metadata: NgffMetadata;
  readonly stats: NetworkStats;
  alignment(level: number): Promise<Alignment>;
  readRegion(level: number, region: PlaneRequest): Promise<Pixels>;
}
export interface ImageRegion extends Region {
  imageId: string;
  level: number;
  channels: number[];
  pixels: Pixels[];
  labels?: Uint32Array;
  z: number;
  t: number;
}

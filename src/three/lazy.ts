import { lazy } from 'react'

// The 3D code (three.js, R3F, the player model) lives in its own chunk and only
// loads when a 3D feature is used, so the 2D game starts fast.
export const loadReplay3D = () => import('./Replay3D')
export const loadProScan3D = () => import('./ProScan3D')
export const Replay3D = lazy(loadReplay3D)
export const ProScan3D = lazy(loadProScan3D)

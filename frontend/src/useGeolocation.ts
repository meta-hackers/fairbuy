import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShoppingLocation } from '@fairbuy/core';
import { api } from './api';

function detectLocation(): Promise<ShoppingLocation> {
  if (!window.isSecureContext) return Promise.reject(new Error('Automatic location needs HTTPS. Set your location manually below.'));
  if (!navigator.geolocation) return Promise.reject(new Error('Your browser does not support location detection. Set your location manually below.'));
  return new Promise<GeolocationPosition>((resolve, reject) => {
    // Some browsers do not start their own timeout while the permission prompt is open.
    const timer = window.setTimeout(() => reject(new Error('Location detection timed out. Try again or set your location manually.')), 12000);
    navigator.geolocation.getCurrentPosition(position => {
      window.clearTimeout(timer); resolve(position);
    }, error => {
      window.clearTimeout(timer);
      reject(new Error(error.code === 1
        ? ''
        : 'Your position is unavailable. Try again or set your location manually.'));
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }).then(position => api<ShoppingLocation>('/location/reverse', 'POST', {
    latitude: Number(position.coords.latitude.toFixed(2)), longitude: Number(position.coords.longitude.toFixed(2)),
  }));
}

export function useGeolocation(automatic: boolean) {
  const [location, setLocation] = useState<ShoppingLocation | null>(null);
  const [pending, setPending] = useState(false); const [message, setMessage] = useState('');
  const initial = useRef<Promise<ShoppingLocation> | null>(null); const sequence = useRef(0);
  const run = useCallback(async (request: Promise<ShoppingLocation>) => {
    const id = ++sequence.current;
    setPending(true); setMessage('');
    try {
      const next = await request;
      if (id !== sequence.current) return null;
      setLocation(next); return next;
    } catch (error) {
      if (id === sequence.current) setMessage((error as Error).message);
      return null;
    } finally { if (id === sequence.current) setPending(false); }
  }, []);
  useEffect(() => {
    // Wait for the saved brief before asking the browser. A country supplied in
    // Ask is authoritative and also invalidates any unfinished automatic result.
    if (!automatic) { setPending(false); setMessage(''); return; }
    // Reuse the first request during React StrictMode's effect replay.
    void run(initial.current ??= detectLocation());
    return () => { sequence.current++; };
  }, [automatic, run]);
  const locate = () => run(detectLocation());
  const cancel = () => { sequence.current++; setPending(false); setMessage(''); };
  return { location, pending, message, locate, cancel };
}

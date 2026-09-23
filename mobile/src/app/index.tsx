import { useState } from 'react';
import { Control } from '../screens/control';
import { HostPicker } from '../screens/host-picker';

export default function PhonePad() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [openPreview, setOpenPreview] = useState(false);
  if (!origin) return <HostPicker onSelect={selected => { setOpenPreview(false); setOrigin(selected); }} />;
  return <Control key={origin} origin={origin} initialPreview={openPreview} onSelectHost={selected => {
    setOpenPreview(true);
    setOrigin(selected);
  }} />;
}

import { useState } from 'react';
import { Control } from '../screens/control';
import { HostPicker } from '../screens/host-picker';

export default function PhonePad() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [autoSelect, setAutoSelect] = useState(true);
  if (!origin) return <HostPicker autoSelect={autoSelect} onSelect={setOrigin} />;
  return <Control key={origin} origin={origin} onChangeHost={() => {
    setAutoSelect(false);
    setOrigin(null);
  }} />;
}

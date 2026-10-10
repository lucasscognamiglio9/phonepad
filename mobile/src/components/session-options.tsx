import { appearance } from './appearance';
import { useRef } from 'react';
import { selectionAsync } from 'expo-haptics';
import { Modal, Platform, ScrollView, View, Text, Pressable, useWindowDimensions } from 'react-native';
import { Host, Slider } from '@expo/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from './glass-surface';
import { controlPercentage, controlValue, type ControlPreferences } from '../lib/control-preferences';

function PreferenceSlider({ label, value, min, max, update, display }: {
 label: string; value: number; min: number; max: number; update: (value: number) => void; display: string;
}) {
 const selected = useRef(value);
 selected.current = value;
 const changeValue = (raw: number) => {
  if (!Number.isFinite(raw)) return;
  const next = Math.max(min, Math.min(max, raw));
  if (next === selected.current) return;
  const previous = selected.current;
  selected.current = next;
  update(next);
  // Only crossing a reference value produces a tick. Landing on it counts
  // once; leaving that exact value must not produce a second tick.
  const crossed = next > previous
   ? Math.floor(next / appearance.slider.hapticInterval) > Math.floor(previous / appearance.slider.hapticInterval)
   : Math.ceil(next / appearance.slider.hapticInterval) < Math.ceil(previous / appearance.slider.hapticInterval);
  if (crossed) void selectionAsync().catch(() => {});
 };
 return <View style={{gap: appearance.control.gap}}>
  <View style={{flexDirection:'row',justifyContent:'space-between'}}>
   <Text style={{color:appearance.color.text,fontSize: appearance.text.body}}>{label}</Text>
   <Text style={{color:appearance.color.secondary,fontSize: appearance.text.body,fontVariant:['tabular-nums']}}>{display}</Text>
  </View>
  <Host accessibilityLabel={label} colorScheme="dark" seedColor={appearance.color.text} style={{height:appearance.control.size}}>
   <Slider value={value} min={min} max={max} onValueChange={changeValue} testID={label} />
  </Host>
 </View>;
}

export function SessionOptions({ visible, close, preferences, change }: {
 visible: boolean; close: () => void; preferences: ControlPreferences; change: (value: ControlPreferences) => void;
}) {
 const insets = useSafeAreaInsets();
 const {width,height}=useWindowDimensions();
 if (!visible) return null;
 const content =
  <View style={{position:'absolute',inset:0}} accessibilityViewIsModal>
   <Pressable accessibilityRole="button" accessibilityLabel="Cerrar ajustes de mouse" onPress={close} style={{position:'absolute',inset:0}} />
   <GlassSurface interactive style={{position:'absolute',top:insets.top+appearance.control.size+appearance.control.gap*2,right:insets.right+appearance.control.margin,width:Math.min(appearance.control.menuWidth,width-insets.left-insets.right-2*appearance.control.margin),maxHeight:Math.max(1,height-insets.top-insets.bottom-appearance.control.size-2*appearance.control.margin-appearance.control.gap),borderRadius:appearance.control.menuRadius,overflow:'hidden'}}>
    <ScrollView contentContainerStyle={{padding:appearance.control.margin,gap:appearance.control.gap}}>
     <PreferenceSlider label="Sensibilidad" value={controlPercentage('gain',preferences.gain)} min={appearance.slider.min} max={appearance.slider.max} update={value=>change({...preferences,gain:controlValue('gain',value)})} display={Math.round(controlPercentage('gain',preferences.gain))+'%'} />
     <PreferenceSlider label="Tamaño del cursor" value={controlPercentage('cursorScale',preferences.cursorScale)} min={appearance.slider.min} max={appearance.slider.max} update={value=>change({...preferences,cursorScale:controlValue('cursorScale',value)})} display={Math.round(controlPercentage('cursorScale',preferences.cursorScale))+'%'} />
    </ScrollView>
   </GlassSurface>
  </View>
 ;
 return Platform.OS === 'ios' ? content : <Modal visible transparent animationType="fade" supportedOrientations={['portrait','landscape']} onRequestClose={close}>{content}</Modal>;
}

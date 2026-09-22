import { appearance } from './appearance';
import { Modal, Platform, ScrollView, View, Text, Pressable, useWindowDimensions } from 'react-native';
import { Host, Slider } from '@expo/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from './glass-surface';
import type { ControlPreferences } from '../lib/control-preferences';

export function SessionOptions({ visible, close, preferences, change }: {
 visible: boolean; close: () => void; preferences: ControlPreferences; change: (value: ControlPreferences) => void;
}) {
 const insets = useSafeAreaInsets();
 const {width,height}=useWindowDimensions();
 const slider = (label: string, value: number, min: number, max: number, step: number, update: (value: number) => void, display: string) =>
  <View style={{gap: appearance.control.gap}}>
   <View style={{flexDirection:'row',justifyContent:'space-between'}}>
    <Text style={{color:appearance.color.text,fontSize:15}}>{label}</Text>
    <Text style={{color:appearance.color.secondary,fontSize:15,fontVariant:['tabular-nums']}}>{display}</Text>
   </View>
   <Host accessibilityLabel={label} colorScheme="dark" seedColor={appearance.color.text} style={{height:appearance.control.size}}>
    <Slider value={value} min={min} max={max} step={step} onValueChange={update} testID={label} />
   </Host>
  </View>;
 if (!visible) return null;
 const content =
  <View style={{position:'absolute',inset:0}} accessibilityViewIsModal>
   <Pressable accessibilityRole="button" accessibilityLabel="Cerrar ajustes de mouse" onPress={close} style={{position:'absolute',inset:0}} />
   <GlassSurface interactive style={{position:'absolute',top:insets.top+appearance.control.size+appearance.control.gap*2,right:insets.right+appearance.control.margin,width:Math.min(appearance.control.menuWidth,width-insets.left-insets.right-2*appearance.control.margin),maxHeight:height-insets.top-insets.bottom-appearance.control.size-2*appearance.control.margin-appearance.control.gap,borderRadius:appearance.control.menuRadius,overflow:'hidden'}}>
    <ScrollView contentContainerStyle={{padding:appearance.control.margin,gap:appearance.control.gap}}>
     {slider('Sensibilidad',preferences.gain,.5,4,.1,value=>change({...preferences,gain:Math.round(value*10)/10}),preferences.gain.toFixed(1)+'×')}
     {slider('Tamaño del cursor',preferences.cursorScale,.5,1.5,.05,value=>change({...preferences,cursorScale:Math.round(value*100)/100}),Math.round(preferences.cursorScale*100)+'%')}
    </ScrollView>
   </GlassSurface>
  </View>
 ;
 return Platform.OS === 'ios' ? content : <Modal visible transparent animationType="fade" supportedOrientations={['portrait','landscape']} onRequestClose={close}>{content}</Modal>;
}

import { appearance } from './appearance';
import { Modal, ScrollView, View, Text, Pressable, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from './glass-surface';
import type { ControlPreferences } from '../lib/control-preferences';
export function SessionOptions({ visible, close, preferences, change, direct, clipboard, copy, busy, notice, help, hosts }: {
 visible: boolean; close: () => void; preferences: ControlPreferences; change: (value: ControlPreferences) => void;
 direct: boolean; clipboard: boolean; copy: (direction: 'phone' | 'host') => void; busy: boolean; notice: string; help: () => void; hosts: () => void;
}) {
 const insets = useSafeAreaInsets();
 const {width,height}=useWindowDimensions();
 const row=(label:string,action:()=>void,disabled=false,selected=false)=><Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled,selected}} disabled={disabled} onPress={action} style={{minHeight:appearance.control.size,paddingHorizontal:16,justifyContent:'center',opacity:disabled?.4:1}}><Text style={{color:appearance.color.text,fontSize:15}}>{selected?'✓  ':''}{label}</Text></Pressable>;
 return <Modal visible={visible} transparent animationType="fade" supportedOrientations={['portrait','landscape']} onRequestClose={close}>
  <View style={{flex:1}} accessibilityViewIsModal>
   <Pressable accessibilityRole="button" accessibilityLabel="Cerrar menú" onPress={close} style={{position:'absolute',inset:0}} />
   <GlassSurface material="regular" style={{position:'absolute',top:insets.top+appearance.control.size+appearance.control.gap*2,right:insets.right+appearance.control.margin,width:Math.min(appearance.control.menuWidth,width-insets.left-insets.right-2*appearance.control.margin),maxHeight:height-insets.top-insets.bottom-appearance.control.size-2*appearance.control.margin-appearance.control.gap,borderRadius:appearance.control.menuRadius,overflow:'hidden'}}>
    <ScrollView contentContainerStyle={{paddingVertical:8}}>
     {row('Trackpad',()=>{change({...preferences,mode:'trackpad'});close();},false,preferences.mode==='trackpad')}
     {row('Directo',()=>{change({...preferences,mode:'direct'});close();},!direct,preferences.mode==='direct')}
     <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:4}}>
      {row('−',()=>change({...preferences,gain:Math.max(.5,preferences.gain-.1)}),preferences.gain<=.5)}
      <Text style={{color:appearance.color.text,fontSize:14}}>Sensibilidad {preferences.gain.toFixed(1)}×</Text>
      {row('+',()=>change({...preferences,gain:Math.min(2,preferences.gain+.1)}),preferences.gain>=2)}
     </View>
     {row('Copiar al teléfono',()=>copy('phone'),busy||!clipboard)}
     {row('Copiar al equipo',()=>copy('host'),busy||!clipboard)}
     {!!notice&&<Text accessibilityLiveRegion="polite" style={{color:appearance.color.secondary,fontSize:13,paddingHorizontal:16}}>{notice}</Text>}
     {row('Ayuda',help)}{row('Equipos',hosts)}
    </ScrollView>
   </GlassSurface>
  </View>
 </Modal>;
}

import { Modal, ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ControlPreferences } from '../lib/control-preferences';
export function SessionOptions({ visible, close, preferences, change, direct, clipboard, copy, busy, notice, help, hosts }: {
 visible: boolean; close: () => void; preferences: ControlPreferences; change: (value: ControlPreferences) => void;
 direct: boolean; clipboard: boolean; copy: (direction: 'phone' | 'host') => void; busy: boolean; notice: string; help: () => void; hosts: () => void;
}) {
 const insets = useSafeAreaInsets();
 const button = (label: string, onPress: () => void, disabled = false, selected = false) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} style={[styles.button, { opacity: disabled ? .4 : 1, backgroundColor: selected ? '#254357' : '#242830' }]}><Text style={styles.text}>{label}</Text></Pressable>;
 return <Modal visible={visible} presentationStyle="pageSheet" animationType="slide" supportedOrientations={['portrait','landscape']} onRequestClose={close}>
  <ScrollView contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20, paddingLeft: insets.left + 20, paddingRight: insets.right + 20, gap: 12, backgroundColor: '#090b0e', flexGrow: 1 }} accessibilityViewIsModal>
   <Text accessibilityRole="header" style={[styles.text, {fontSize:24}]}>Controles de sesión</Text>
   {button('Trackpad', () => change({...preferences,mode:'trackpad'}),false,preferences.mode==='trackpad')}
   {button('Directo', () => change({...preferences,mode:'direct'}),!direct,preferences.mode==='direct')}
   {!direct && <Text style={styles.text}>Directo requiere pantalla visible y un host compatible.</Text>}
   <Text style={styles.text}>Recorrido del trackpad: {preferences.gain.toFixed(2)}×. Ajustá hasta recorrer la pantalla en una o dos pasadas. El movimiento lento conserva la aceleración del host; no se cambia la sensibilidad del equipo.</Text>
   <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{button('Más preciso',()=>change({...preferences,gain:Math.max(.5,preferences.gain-.1)}),preferences.gain<=.5)}{button('Más recorrido',()=>change({...preferences,gain:Math.min(2,preferences.gain+.1)}),preferences.gain>=2)}{button('Restablecer',()=>change({...preferences,gain:1}))}</View>
   {button('Copiar al teléfono',()=>copy('phone'),busy||!clipboard)}
   {button('Copiar al equipo',()=>copy('host'),busy||!clipboard)}
   <Text style={styles.text}>Copia texto completo, hasta 128 KiB. No pega ni envía mensajes automáticamente. Para fotos y archivos, usá Adjuntos.</Text>
   {!!notice && <Text accessibilityLiveRegion="polite" style={styles.text}>{notice}</Text>}
   {button('Ayuda',help)}{button('Equipos',hosts)}{button('Cerrar',close)}
  </ScrollView>
 </Modal>;
}
const styles=StyleSheet.create({text:{color:'#f4f5f7',fontSize:16,lineHeight:24},button:{minHeight:48,padding:12,borderRadius:14,justifyContent:'center'}});

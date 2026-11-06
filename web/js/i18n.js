// Visitor languages. The kiosk is written in English; a visitor can switch
// the visitor screens to another language from the welcome screen. Staff
// screens (setup and admin) stay in English.
//
//   t(text, vars)   the kiosk's own text, e.g. t('Step {at} of {total}', { at, total })
//   tc(text)        the business's own text (questions, rules, reasons…): the
//                   translation typed in setup, else a built-in one, else English
//
// Answers are always recorded in English, so rules and reports don't depend
// on the language a visitor chose.
import { settings } from './settings.js';

export const LANGS = { en: 'English', es: 'Español' };

const ES = {
  // ------------------------------------------------ welcome and choice
  'Welcome to': 'Bienvenidos a',
  'Tap anywhere to get started': 'Toque la pantalla para empezar',
  'Sign-ins are paused': 'El registro está en pausa',
  'Sign in as {name}': 'Registrarme como {name}',
  'Pass {badge}': 'Pase {badge}',
  'Please wear your pass where it can be seen. Your host will meet you at the front desk.': 'Por favor, lleve su pase a la vista. Su anfitrión le recibirá en la recepción.',
  'Please take visitor pass {badge}.': 'Por favor, tome el pase de visitante {badge}.',
  'All the visitor passes are in use. Please ask at the front desk for one.': 'Todos los pases de visitante están en uso. Por favor, pida uno en la recepción.',
  "You're signed out. Please give visitor pass {badge} back at the front desk.": 'Su visita ha terminado. Por favor, devuelva el pase de visitante {badge} en la recepción.',
  'When you leave, give your pass back and tap "Leaving?" on the welcome screen to sign out.': 'Cuando se vaya, devuelva su pase y toque "¿Se va?" en la pantalla de bienvenida para cerrar su visita.',
  'When you leave, give your pass back, open this page again and tap "Leaving?" to sign out.': 'Cuando se vaya, devuelva su pase, abra esta página de nuevo y toque "¿Se va?" para cerrar su visita.',
  'This phone remembers you.': 'Este teléfono le recuerda.',
  'Someone else': 'Otra persona',
  'Sign in as a new visitor.': 'Registrarse como visitante nuevo.',
  'When you leave, open this page again and tap "Leaving?" to sign out.': 'Cuando se vaya, abra esta página de nuevo y toque "¿Se va?" para cerrar su visita.',
  'Please sign in as a new visitor.': 'Por favor, regístrese como visitante nuevo.',
  'Signing you out…': 'Cerrando su visita…',
  "This sign-in link isn't working. Please see the front desk.": 'Este enlace de registro no funciona. Por favor, acérquese a la recepción.',
  'Lots of people are signing in right now. Please try again in a few minutes, or see the front desk.': 'Hay muchas personas registrándose ahora. Inténtelo de nuevo en unos minutos o acérquese a la recepción.',
  'Please see the front desk.': 'Por favor, acérquese a la recepción.',
  'Leaving?': '¿Se va?',
  'Tap your visitor badge on the reader to sign out.': 'Acerque su credencial de visitante al lector para registrar su salida.',
  'Tap here to sign out': 'Toque aquí para registrar su salida',
  '‹ Back': '‹ Atrás',
  'Have you visited': '¿Ha visitado',
  'before?': 'antes?',
  'New visitor': 'Primera visita',
  'First time here? Sign in in about two minutes.': '¿Es su primera vez? Regístrese en unos dos minutos.',
  'Returning visitor': 'Ya nos visitó',
  "Been here before? We'll find you in seconds.": '¿Ya vino antes? Encontraremos su registro en segundos.',
  'Leaving? Sign out here ›': '¿Se va? Registre su salida aquí ›',
  'Cancel': 'Cancelar',

  // ------------------------------------------------ sign-in questions
  'Please sign in before your visit. It takes about two minutes.': 'Regístrese antes de su visita. Tarda unos dos minutos.',
  "We use this information only to manage your visit. Please don't enter ID numbers or other sensitive details.": 'Usamos esta información solo para gestionar su visita. No escriba números de identificación ni otros datos confidenciales.',
  'Need help? Ask at the front desk.': '¿Necesita ayuda? Pregunte en la recepción.',
  "What's your name?": '¿Cómo se llama?',
  'As shown on your photo ID.': 'Tal como aparece en su identificación con foto.',
  'First name': 'Nombre',
  'Last name': 'Apellido',
  'About your visit': 'Sobre su visita',
  'Company': 'Empresa',
  "Write “N/A” if you're visiting on your own.": 'Escriba «N/A» si viene por cuenta propia.',
  'Who are you visiting at {company}?': '¿A quién visita en {company}?',
  'The person you are meeting.': 'La persona con quien tiene la cita.',
  'Purpose of your visit': 'Motivo de su visita',
  'Your answer': 'Su respuesta',
  'Take your picture': 'Tómese una foto',
  'Look at the camera. We use it on your visit record so our team knows who you are.': 'Mire a la cámara. La usamos en el registro de su visita para que nuestro equipo sepa quién es usted.',
  "The camera isn't available. Please ask the front desk for help.": 'La cámara no está disponible. Pida ayuda en la recepción.',
  '📸 Take picture': '📸 Tomar foto',
  'Retake': 'Repetir',
  'Visitor rules': 'Normas para visitantes',
  'I agree to the visitor rules. Checking this box is my electronic signature on these rules.': 'Acepto las normas para visitantes. Marcar esta casilla es mi firma electrónica de estas normas.',
  'By signing below, I agree to the visitor rules.': 'Al firmar abajo, acepto las normas para visitantes.',
  'Sign here with your finger': 'Firme aquí con el dedo',
  'Clear': 'Borrar',
  'Email me a copy': 'Envíenme una copia por correo',
  "We'll email you a copy of what you signed.": 'Le enviaremos por correo una copia de lo que firmó.',
  'Please sign in the box to agree to the visitor rules.': 'Firme en el recuadro para aceptar las normas para visitantes.',
  'Please check the email address, or leave it empty.': 'Revise la dirección de correo o déjela en blanco.',
  'Want quick entry next time?': '¿Quiere entrada rápida la próxima vez?',
  'Next time, tap': 'La próxima vez, toque',
  'and the kiosk recognizes you from the camera. No typing.': 'y el quiosco le reconocerá con la cámara. Sin escribir.',
  'If you say yes,': 'Si acepta,',
  'keeps your photos and a numeric face signature made from them, only to recognize you at this kiosk. Each visit adds a fresh photo so it keeps working as you change. Ask the front desk any time to turn it off and delete it.':
    'guarda sus fotos y una firma facial numérica creada a partir de ellas, solo para reconocerle en este quiosco. Cada visita agrega una foto nueva para que siga funcionando aunque usted cambie. Pida en la recepción, cuando quiera, que la desactiven y la borren.',
  'Yes, turn on quick entry': 'Sí, activar la entrada rápida',
  'No thanks': 'No, gracias',
  'Continue': 'Continuar',
  "Let's begin": 'Empecemos',
  'Sign in': 'Registrarme',
  'Step {at} of {total}': 'Paso {at} de {total}',
  'Quick question {at} of {total}': 'Pregunta rápida {at} de {total}',
  'Please answer the question.': 'Responda la pregunta, por favor.',
  'Please choose an answer.': 'Elija una respuesta, por favor.',
  'Please enter your {what}.': 'Escriba su {what}, por favor.',
  'Please enter your first and last name.': 'Escriba su nombre y apellido, por favor.',
  'Please enter your company, or “N/A”.': 'Escriba el nombre de su empresa, o «N/A».',
  'Please answer each question.': 'Responda cada pregunta, por favor.',
  'Please take your picture.': 'Tómese la foto, por favor.',
  'Please check the box to agree to the visitor rules.': 'Marque la casilla para aceptar las normas para visitantes.',
  "We couldn't see your face clearly. You can retake the picture, or continue.": 'No pudimos ver bien su cara. Puede repetir la foto o continuar.',
  "Welcome, {name}! We're expecting you.": '¡Hola, {name}! Le estábamos esperando.',
  "Welcome, {name}! We're expecting you. {host} will be told you're here.": '¡Hola, {name}! Le estábamos esperando. Avisaremos a {host} de que llegó.',

  // ------------------------------------------------ returning visitors
  'Looking for you…': 'Buscando…',
  'Welcome back!': '¡Hola de nuevo!',
  "That's me": 'Soy yo',
  'Start typing your name. If you turned on quick entry, the camera may recognize you first.': 'Empiece a escribir su nombre. Si activó la entrada rápida, la cámara puede reconocerle antes.',
  'Start typing your name.': 'Empiece a escribir su nombre.',
  '(optional)': '(opcional)',
  'Find me': 'Buscarme',
  'Camera off': 'Cámara apagada',
  'Type your name': 'Escriba su nombre',
  'Found you!': '¡Le encontramos!',
  'Welcome back, {name}!': '¡Hola de nuevo, {name}!',
  'Welcome back, {name}': 'Hola de nuevo, {name}',
  "We couldn't find you.": 'No encontramos su registro.',
  'Check the spelling, or sign in as a new visitor. It only takes two minutes.': 'Revise la ortografía o regístrese como visitante nuevo. Solo tarda dos minutos.',
  'Sign in as a new visitor': 'Registrarme como visitante nuevo',
  'Which one is you?': '¿Cuál es usted?',
  'Is this you?': '¿Es usted?',
  'last visit {date}': 'última visita: {date}',
  "That's me ›": 'Soy yo ›',
  'Hi!': '¡Hola!',
  'Hi, {name}!': '¡Hola, {name}!',
  'Want the kiosk to recognize you next time, so you skip the typing?': '¿Quiere que el quiosco le reconozca la próxima vez, sin tener que escribir?',
  'keeps your photos and a numeric face signature, only for this kiosk. Ask the front desk any time to delete it.': 'guarda sus fotos y una firma facial numérica, solo para este quiosco. Pida en la recepción, cuando quiera, que la borren.',

  // ------------------------------------------------ signing out
  'Signing out?': '¿Registrar su salida?',
  'Type your name, then tap it when it appears.': 'Escriba su nombre y tóquelo cuando aparezca.',
  "We couldn't find you signed in.": 'No encontramos un registro de entrada a su nombre.',
  'Check the spelling, or see the front desk.': 'Revise la ortografía o consulte en la recepción.',
  'signed in {time}': 'entró a las {time}',
  'Sign me out ›': 'Registrar mi salida ›',
  'Goodbye!': '¡Adiós!',
  'Goodbye, {name}!': '¡Adiós, {name}!',
  "You're signed out.": 'Su salida quedó registrada.',
  "You're signed out. Please leave badge {badge} at the front desk.": 'Su salida quedó registrada. Deje la credencial {badge} en la recepción, por favor.',
  'Thanks for visiting {org}.': 'Gracias por visitar {org}.',
  'Thanks for visiting.': 'Gracias por su visita.',
  'Undo': 'Deshacer',
  'Not you? Undo': '¿No es usted? Deshacer',
  'Undone. You are still signed in.': 'Listo: su entrada sigue registrada.',
  'Too late to undo. Please see the front desk.': 'Ya no se puede deshacer. Consulte en la recepción.',

  // ------------------------------------------------ badges and finishing
  'Almost done': 'Ya casi termina',
  'Tap any visitor badge on the reader': 'Acerque cualquier credencial de visitante al lector',
  'Pick up a visitor badge from the tray and hold it flat on the reader for a second.': 'Tome una credencial de visitante de la bandeja y apóyela sobre el lector un segundo.',
  'VISITOR': 'VISITANTE',
  'Thanks, {name}!': '¡Gracias, {name}!',
  'Tap any visitor badge on the reader to finish': 'Acerque cualquier credencial de visitante al lector para terminar',
  'Last step: tap any visitor badge on the reader': 'Último paso: acerque cualquier credencial de visitante al lector',
  'Reading your badge…': 'Leyendo su credencial…',
  'Badge {badge} is yours!': '¡La credencial {badge} es suya!',
  "You're all set!": '¡Listo!',
  "You're all set, {name}!": '¡Listo, {name}!',
  'Badge {badge}': 'Credencial {badge}',
  "We've let {host} know you're here.": 'Ya avisamos a {host} de que llegó.',
  'Please wear your badge where it can be seen. Your host will meet you at the front desk.': 'Lleve su credencial a la vista. Su anfitrión le recibirá en la recepción.',
  'Please take a seat. Your host will meet you at the front desk.': 'Tome asiento, por favor. Su anfitrión le recibirá en la recepción.',
  'When you leave, tap your badge on the reader to sign out.': 'Al salir, acerque su credencial al lector para registrar su salida.',
  'When you leave, tap "Leaving?" on the welcome screen to sign out.': 'Al salir, toque «¿Se va?» en la pantalla de bienvenida para registrar su salida.',
  'Done': 'Listo',
  'Thank you': 'Gracias',
  'Thank you, {name}': 'Gracias, {name}',
  'A member of our team has been notified and will be with you shortly.': 'Ya avisamos a nuestro equipo y alguien le atenderá en breve.',
  'Welcome! A member of staff has already approved your visit.': '¡Bienvenido! Un miembro del personal ya aprobó su visita.',
  "This kiosk doesn't use badges. Sign in and out on the screen.": 'Este quiosco no usa credenciales. Registre su entrada y salida en la pantalla.',
  'Finish signing in first. You will tap your badge at the end.': 'Primero termine de registrarse. Acercará su credencial al final.',

  // ------------------------------------------------ waiting and problems
  'Are you still there?': '¿Sigue ahí?',
  'Starting over in': 'Volveremos al inicio en',
  'seconds.': 'segundos.',
  "I'm still here": 'Sigo aquí',
  'One moment…': 'Un momento…',
  'Saving your sign-in…': 'Guardando su registro…',
  'Signing you in…': 'Registrando su entrada…',
  'Looking you up…': 'Buscando su registro…',
  'Turning on quick entry…': 'Activando la entrada rápida…',
  'Signing you out…': 'Registrando su salida…',
  "We couldn't reach the server. Please try again, or see the front desk.": 'No pudimos conectar con el servidor. Inténtelo de nuevo o consulte en la recepción.',
  'The system is busy. Please try again.': 'El sistema está ocupado. Inténtelo de nuevo.',
  "This badge isn't set up yet. Please use a different badge, or see the front desk.": 'Esta credencial aún no está configurada. Use otra credencial o consulte en la recepción.',
  'Badge {badge} is already checked out to someone. Please use a different badge.': 'La credencial {badge} ya está asignada a otra persona. Use otra credencial.',
  'Badge {badge} is out of service. Please use a different badge.': 'La credencial {badge} está fuera de servicio. Use otra credencial.',
  'Some answers are missing. Please go back and check.': 'Faltan algunas respuestas. Regrese y revíselas.',
  'This kiosk is not connected correctly. Please see the front desk.': 'Este quiosco no está bien conectado. Consulte en la recepción.',
  'Something went wrong. Please see the front desk.': 'Algo salió mal. Consulte en la recepción.',

  // ------------------------------------------------ on-screen keyboard
  'space': 'espacio',

  // ------------------------------------------------ built-in content (setup defaults and ready-made questions)
  'Meeting': 'Reunión',
  'Interview': 'Entrevista',
  'Delivery': 'Entrega',
  'Supplier visit': 'Visita de proveedor',
  'Contractor or maintenance': 'Contratista o mantenimiento',
  'Other': 'Otro',
  'Quality audit': 'Auditoría de calidad',
  'First article review': 'Revisión de primer artículo',
  'Equipment service': 'Servicio de equipos',
  'Yes': 'Sí',
  'No': 'No',
  'Not sure': 'No estoy seguro/a',
  'I will stay with my host or escort at all times while I am past the front desk.': 'Permaneceré con mi anfitrión o acompañante en todo momento después de la recepción.',
  'I will not take photos, video or audio recordings in production or restricted areas.': 'No tomaré fotos, videos ni grabaciones de audio en áreas de producción o restringidas.',
  'Anything confidential I see or hear during my visit stays confidential.': 'Todo lo confidencial que vea u oiga durante mi visita seguirá siendo confidencial.',
  'I will follow all safety instructions and wear any protective equipment I am given.': 'Seguiré todas las instrucciones de seguridad y usaré el equipo de protección que me entreguen.',
  'I will sign out before I leave and return any visitor badge I was given.': 'Registraré mi salida antes de irme y devolveré la credencial de visitante que me hayan entregado.',
  'I will stay with my {company} escort at all times while I am past the front desk.': 'Permaneceré con mi acompañante de {company} en todo momento después de la recepción.',
  'I will not take photos, video or audio recordings, and I will keep my phone put away in production and controlled areas.': 'No tomaré fotos, videos ni grabaciones de audio, y mantendré mi teléfono guardado en las áreas de producción y controladas.',
  'Drawings, parts and processes I see may be controlled under the International Traffic in Arms Regulations (ITAR) and the Export Administration Regulations (EAR), and are confidential to {company} and its customers. I will not copy, remove or disclose them.':
    'Los planos, piezas y procesos que vea pueden estar controlados por el Reglamento Internacional de Tráfico de Armas (ITAR) y el Reglamento de Administración de Exportaciones (EAR), y son confidenciales para {company} y sus clientes. No los copiaré, retiraré ni divulgaré.',
  'The citizenship status I gave {company} is true. I will tell my escort if it changes.': 'La situación de ciudadanía que di a {company} es verdadera. Avisaré a mi acompañante si cambia.',
  'I will return my visitor badge before I leave.': 'Devolveré mi credencial de visitante antes de irme.',
  'Thank you for visiting {company}. Unfortunately, we are unable to sign you in today. We apologize for any inconvenience.': 'Gracias por visitar {company}. Lamentablemente, hoy no podemos registrar su entrada. Disculpe las molestias.',
  "Thank you for coming in. We're not able to complete your sign-in at the kiosk today. Please wait here, and a member of our team will help you shortly.": 'Gracias por venir. Hoy no podemos completar su registro en el quiosco. Espere aquí, por favor; alguien de nuestro equipo le atenderá en breve.',
  "Thank you for visiting {company}. For security reasons we can't sign you in at the kiosk. Please speak with the front desk.": 'Gracias por visitar {company}. Por motivos de seguridad, no podemos registrar su entrada en el quiosco. Hable con la recepción, por favor.',
  'Citizenship status': 'Situación de ciudadanía',
  'Required by U.S. export law. The front desk may confirm it against your photo ID.': 'Lo exige la ley de exportación de EE. UU. La recepción puede verificarlo con su identificación con foto.',
  'U.S. citizen': 'Ciudadano/a de EE. UU.',
  'Lawful permanent resident (green card holder)': 'Residente permanente legal (titular de green card)',
  'Protected individual (asylee or refugee)': 'Persona protegida (asilado/a o refugiado/a)',
  'Not a U.S. citizen or permanent resident': 'No soy ciudadano/a ni residente permanente de EE. UU.',
  'Country of citizenship': 'País de ciudadanía',
  "Some of the products and technical data we work with are controlled under U.S. export laws (ITAR and EAR). To follow these laws, we need to know each visitor's citizenship status before they go past the front desk.":
    'Algunos de los productos y datos técnicos con los que trabajamos están controlados por las leyes de exportación de EE. UU. (ITAR y EAR). Para cumplirlas, necesitamos conocer la situación de ciudadanía de cada visitante antes de que pase de la recepción.',
  'Some of the products and technical data we work with are controlled under U.S. export laws (ITAR and EAR). To follow these laws, we need to know each visitor’s citizenship status before they go past the front desk.':
    'Algunos de los productos y datos técnicos con los que trabajamos están controlados por las leyes de exportación de EE. UU. (ITAR y EAR). Para cumplirlas, necesitamos conocer la situación de ciudadanía de cada visitante antes de que pase de la recepción.',
  'Do you have symptoms of a contagious illness today, such as a fever or a cough?': '¿Tiene hoy síntomas de una enfermedad contagiosa, como fiebre o tos?',
  'Are you carrying any weapons or other prohibited items?': '¿Lleva consigo armas u otros artículos prohibidos?',
  'Have you completed our site safety induction?': '¿Completó nuestra inducción de seguridad?',
  'Are you bringing any tools or equipment on site today?': '¿Trae hoy herramientas o equipos a nuestras instalaciones?',
  'Has your company signed a non-disclosure agreement with us?': '¿Su empresa firmó un acuerdo de confidencialidad con nosotros?',
  'Would you like any accessibility assistance during your visit?': '¿Desea asistencia de accesibilidad durante su visita?',
};

const DICTS = { es: ES };
let current = 'en';

export const lang = () => current;
/** The locale for dates and times in the current language. */
export const locale = () => (current === 'en' ? [] : [current]);

/** The kiosk's own text in the current language. */
export function t(text, vars) {
  const s = (current !== 'en' && DICTS[current]?.[text]) || text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}

/** Whether the built-in dictionary has this text (setup shows these as already translated). */
export const builtIn = (code, text) => DICTS[code]?.[text] || '';

/** The business's own text: their translation, a built-in one, or the English. */
export function tc(text, s = settings()) {
  if (current === 'en' || !text) return text;
  return s.translations?.[current]?.[text] || DICTS[current]?.[text] || text;
}

// ------------------------------------------------ the static text on the visitor screens

const originals = new WeakMap();

/**
 * Translates the text written into the page (index.html) inside these
 * elements, and puts the English back when switching back.
 */
export function translateDom(roots) {
  for (const root of roots) {
    if (!root) continue;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      if (node.parentElement?.closest('[data-no-i18n]')) continue;
      const orig = originals.get(node) ?? node.nodeValue;
      const key = orig.replace(/\s+/g, ' ').trim();
      if (!key) continue;
      const out = t(key);
      if (out === key) {
        if (originals.has(node)) node.nodeValue = orig;
        continue;
      }
      originals.set(node, orig);
      const lead = /^\s*/.exec(orig)[0], trail = /\s*$/.exec(orig)[0];
      node.nodeValue = lead + out + trail;
    }
  }
}

/** Switches the visitor screens' language. */
export function setLang(code) {
  current = LANGS[code] ? code : 'en';
  document.documentElement.lang = current;
}

// Each garment lists which measurements matter AND how to describe them to Gemini
export const GARMENTS = {
  kurti: {
    label:"Kurti", emoji:"👘",
    measurements:["bust","waist","hip","shoulder_width","sleeve_length","garment_length"],
    geminiContext:"Indian kurti/top. Bust = fullest chest circumference. Garment length = shoulder to desired hem."
  },
  salwar:{
    label:"Salwar / Churidar", emoji:"🩱",
    measurements:["waist","hip","inseam","thigh","calf","ankle"],
    geminiContext:"Indian salwar/churidar bottoms. Waist = natural waist. Inseam = crotch to ankle inside leg."
  },
  shirt:{
    label:"Shirt", emoji:"👔",
    measurements:["bust","waist","shoulder_width","sleeve_length","collar"],
    geminiContext:"Formal/casual shirt. Collar = neck circumference. Sleeve = shoulder point to wrist."
  },
  blouse:{
    label:"Blouse / Choli", emoji:"👚",
    measurements:["bust","waist","under_bust","shoulder_width","sleeve_length","back_length"],
    geminiContext:"Indian blouse/choli. Under-bust = circumference just below bust. Back length = nape of neck to waist."
  },
  trousers:{
    label:"Trousers", emoji:"👖",
    measurements:["waist","hip","inseam","thigh","knee","ankle","rise"],
    geminiContext:"Trousers/pants. Rise = crotch to waistband front. Thigh = fullest thigh circumference."
  },
  saree_blouse:{
    label:"Saree Blouse", emoji:"🥻",
    measurements:["bust","waist","under_bust","shoulder_width","back_length","sleeve_length"],
    geminiContext:"Saree blouse — fitted. Accuracy critical. Under-bust and back length especially important."
  },
  lehenga:{
    label:"Lehenga", emoji:"🎽",
    measurements:["waist","hip","garment_length","bust"],
    geminiContext:"Lehenga skirt. Garment length = waist to floor. Hip = fullest hip circumference."
  },
  sherwani:{
    label:"Sherwani", emoji:"🥿",
    measurements:["bust","waist","hip","shoulder_width","sleeve_length","garment_length","collar"],
    geminiContext:"Indian sherwani for men. Garment length = shoulder to knee. All circumferences are critical."
  },
};

export const MEASUREMENT_LABELS = {
  bust:"Bust / Chest", waist:"Waist", hip:"Hip",
  shoulder_width:"Shoulder Width", sleeve_length:"Sleeve Length",
  garment_length:"Garment Length", inseam:"Inseam",
  thigh:"Thigh", calf:"Calf", ankle:"Ankle",
  collar:"Collar", under_bust:"Under Bust",
  back_length:"Back Length", knee:"Knee", rise:"Rise",
};

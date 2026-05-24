// Vercel Serverless Function for Video-to-Video Generation using fal.ai Kling Video API
// This function handles video upload and submits the request to fal.ai

const { requireAuth } = require('../lib/_auth');
const { uploadBufferToFal } = require('../lib/_fal_upload');
const { generateGoogleVideoFallback, getGoogleVideoModelId, hasGoogleApiKey } = require('../lib/_google_fallback');
const FAL_API_KEY = process.env.FAL_API_KEY || process.env.FAL_KEY;

// Option definitions with types, values, and defaults for UI rendering
const OPTION_DEFS = {
    "aspect_ratio_hunyuan": {
        "type": "select",
        "values": [
            "16:9",
            "9:16"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "resolution_hunyuan": {
        "type": "select",
        "values": [
            "480p",
            "580p",
            "720p"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "enable_safety_checker": {
        "type": "bool",
        "default": true,
        "label": "Safety Check"
    },
    "enable_safety_checker_off": {
        "type": "bool",
        "default": false,
        "label": "Safety Check"
    },
    "enable_output_safety_checker_off": {
        "type": "bool",
        "default": false,
        "label": "Output Safety"
    },
    "num_frames_hunyuan": {
        "type": "select",
        "values": [
            "129",
            "85"
        ],
        "default": 129,
        "label": "Frames"
    },
    "pro_mode": {
        "type": "bool",
        "default": false,
        "label": "Pro Mode"
    },
    "duration_ltx2": {
        "type": "select",
        "values": [
            6,
            8,
            10,
            12,
            14,
            16,
            18,
            20
        ],
        "default": 6,
        "label": "Duration (sec)"
    },
    "resolution_ltx2": {
        "type": "select",
        "values": [
            "1080p",
            "1440p",
            "2160p"
        ],
        "default": "1080p",
        "label": "Resolution"
    },
    "generate_audio": {
        "type": "bool",
        "default": false,
        "label": "Generate Audio"
    },
    "generate_audio_on": {
        "type": "bool",
        "default": true,
        "label": "Generate Audio"
    },
    "fps_ltx2": {
        "type": "select",
        "values": [
            25,
            50
        ],
        "default": 25,
        "label": "FPS"
    },
    "duration_ltx23_fast": {
        "type": "select",
        "values": [
            6,
            8,
            10,
            12,
            14,
            16,
            18,
            20
        ],
        "default": 6,
        "label": "Duration (sec)"
    },
    "duration_ltx23_pro": {
        "type": "select",
        "values": [
            6,
            8,
            10
        ],
        "default": 6,
        "label": "Duration (sec)"
    },
    "aspect_ratio_ltx23": {
        "type": "select",
        "values": [
            "16:9",
            "9:16"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_ltx23_i2v": {
        "type": "select",
        "values": [
            "auto",
            "16:9",
            "9:16"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "fps_ltx23": {
        "type": "select",
        "values": [
            24,
            25,
            48,
            50
        ],
        "default": 25,
        "label": "FPS"
    },
    "start_time_ltx23": {
        "type": "number",
        "default": 0,
        "min": 0,
        "max": 20,
        "step": 0.1,
        "label": "Start Time (sec)"
    },
    "duration_ltx23_retake": {
        "type": "number",
        "default": 5,
        "min": 2,
        "max": 20,
        "step": 0.1,
        "label": "Duration (sec)"
    },
    "retake_mode_ltx23": {
        "type": "select",
        "values": [
            "replace_audio",
            "replace_video",
            "replace_audio_and_video"
        ],
        "default": "replace_audio_and_video",
        "label": "Retake Mode"
    },
    "duration_ltx23_extend": {
        "type": "number",
        "default": 5,
        "min": 1,
        "max": 20,
        "step": 0.1,
        "label": "Duration (sec)"
    },
    "extend_mode_ltx23": {
        "type": "select",
        "values": [
            "start",
            "end"
        ],
        "default": "end",
        "label": "Extend Mode"
    },
    "context_ltx23": {
        "type": "number",
        "min": 0,
        "max": 20,
        "step": 0.1,
        "label": "Context (sec)"
    },
    "guidance_scale_ltx23_audio": {
        "type": "number",
        "default": 5,
        "min": 1,
        "max": 50,
        "step": 0.1,
        "label": "Guidance Scale"
    },
    "duration_seedance_lite": {
        "type": "select",
        "values": [
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "11",
            "12"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "duration_seedance_pro": {
        "type": "select",
        "values": [
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "11",
            "12"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "aspect_ratio_seedance_lite": {
        "type": "select",
        "values": [
            "21:9",
            "16:9",
            "4:3",
            "1:1",
            "3:4",
            "9:16",
            "9:21"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_seedance_lite_i2v": {
        "type": "select",
        "values": [
            "21:9",
            "16:9",
            "4:3",
            "1:1",
            "3:4",
            "9:16",
            "auto"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_seedance_pro": {
        "type": "select",
        "values": [
            "21:9",
            "16:9",
            "4:3",
            "1:1",
            "3:4",
            "9:16",
            "auto"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "resolution_seedance": {
        "type": "select",
        "values": [
            "480p",
            "720p",
            "1080p"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "duration_seedance2": {
        "type": "select",
        "values": [
            "auto",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "11",
            "12",
            "13",
            "14",
            "15"
        ],
        "default": "auto",
        "label": "Duration (sec)"
    },
    "aspect_ratio_seedance2_t2v_ref": {
        "type": "select",
        "values": [
            "auto",
            "21:9",
            "16:9",
            "4:3",
            "1:1",
            "3:4",
            "9:16"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_seedance2_i2v": {
        "type": "select",
        "values": [
            "auto",
            "21:9",
            "16:9",
            "4:3",
            "1:1",
            "3:4",
            "9:16"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "resolution_seedance2_fast": {
        "type": "select",
        "values": [
            "480p",
            "720p"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "resolution_seedance2_pro": {
        "type": "select",
        "values": [
            "480p",
            "720p",
            "1080p"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "aspect_ratio_happy_horse": {
        "type": "select",
        "values": [
            "16:9",
            "9:16",
            "1:1",
            "4:3",
            "3:4"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "resolution_happy_horse": {
        "type": "select",
        "values": [
            "720p",
            "1080p"
        ],
        "default": "1080p",
        "label": "Resolution"
    },
    "duration_happy_horse": {
        "type": "select",
        "values": [
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15
        ],
        "default": 5,
        "label": "Duration (sec)"
    },
    "camera_fixed": {
        "type": "bool",
        "default": false,
        "label": "Fixed Camera"
    },
    "aspect_ratio_sora": {
        "type": "select",
        "values": [
            "9:16",
            "16:9"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_sora_i2v": {
        "type": "select",
        "values": [
            "auto",
            "9:16",
            "16:9"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "resolution_sora": {
        "type": "select",
        "values": [
            "720p",
            "1080p"
        ],
        "default": "1080p",
        "label": "Resolution"
    },
    "resolution_sora_i2v": {
        "type": "select",
        "values": [
            "auto",
            "720p",
            "1080p"
        ],
        "default": "auto",
        "label": "Resolution"
    },
    "duration_sora": {
        "type": "select",
        "values": [
            4,
            8,
            12
        ],
        "default": 4,
        "label": "Duration (sec)"
    },
    "delete_video": {
        "type": "bool",
        "default": true,
        "label": "Delete After"
    },
    "detect_and_block_ip": {
        "type": "bool",
        "default": false,
        "label": "Block IP Content"
    },
    "duration_kling": {
        "type": "select",
        "values": [
            "5",
            "10"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "duration_kling_o1": {
        "type": "select",
        "values": [
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "duration_kling3": {
        "type": "select",
        "values": [
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "11",
            "12",
            "13",
            "14",
            "15"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "duration_kling3_optional": {
        "type": "select",
        "values": [
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "11",
            "12",
            "13",
            "14",
            "15"
        ],
        "default": null,
        "label": "Duration (sec)",
        "allowEmpty": true,
        "emptyLabel": "Default"
    },
    "aspect_ratio_kling": {
        "type": "select",
        "values": [
            "16:9",
            "9:16",
            "1:1"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_kling_o1_auto": {
        "type": "select",
        "values": [
            "auto",
            "16:9",
            "9:16",
            "1:1"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_kling_o1_ref": {
        "type": "select",
        "values": [
            "16:9",
            "9:16",
            "1:1"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_kling3": {
        "type": "select",
        "values": [
            "16:9",
            "9:16",
            "1:1"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_o3_v2v": {
        "type": "select",
        "values": [
            "auto",
            "16:9",
            "9:16",
            "1:1"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "negative_prompt": {
        "type": "text",
        "label": "Negative Prompt"
    },
    "negative_prompt_kling": {
        "type": "text",
        "default": "blur, distort, and low quality",
        "label": "Negative Prompt"
    },
    "negative_prompt_ltx_video": {
        "type": "text",
        "default": "low quality, worst quality, deformed, distorted, disfigured, motion smear, motion artifacts, fused fingers, bad anatomy, weird hand, ugly",
        "label": "Negative Prompt"
    },
    "negative_prompt_animatediff": {
        "type": "text",
        "default": "(bad quality, worst quality:1.2), ugly faces, bad anime",
        "label": "Negative Prompt"
    },
    "cfg_scale": {
        "type": "number",
        "default": 0.5,
        "label": "CFG Scale"
    },
    "cfg_scale_framepack": {
        "type": "number",
        "default": 1,
        "label": "CFG Scale"
    },
    "voice_ids": {
        "type": "text",
        "label": "Voice IDs (comma separated)"
    },
    "duration_veo2": {
        "type": "select",
        "values": [
            "5s",
            "6s",
            "7s",
            "8s"
        ],
        "default": "5s",
        "label": "Duration"
    },
    "aspect_ratio_veo31_i2v": {
        "type": "select",
        "values": [
            "auto",
            "16:9",
            "9:16"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_veo31_ref": {
        "type": "select",
        "values": [
            "16:9",
            "9:16"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "resolution_veo31": {
        "type": "select",
        "values": [
            "720p",
            "1080p",
            "4k"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "duration_veo31_i2v": {
        "type": "select",
        "values": [
            "4s",
            "6s",
            "8s"
        ],
        "default": "8s",
        "label": "Duration"
    },
    "duration_veo31_ref": {
        "type": "text",
        "default": "8s",
        "label": "Duration"
    },
    "safety_tolerance_veo31": {
        "type": "select",
        "values": [
            "1",
            "2",
            "3",
            "4",
            "5",
            "6"
        ],
        "default": "4",
        "label": "Safety Tolerance"
    },
    "auto_fix": {
        "type": "bool",
        "default": false,
        "label": "Auto Fix Prompt"
    },
    "aspect_ratio_wan": {
        "type": "select",
        "values": [
            "16:9",
            "9:16",
            "1:1",
            "4:3",
            "3:4"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_wan22": {
        "type": "select",
        "values": [
            "auto",
            "16:9",
            "9:16",
            "1:1"
        ],
        "default": "auto",
        "label": "Aspect Ratio"
    },
    "resolution_wan": {
        "type": "select",
        "values": [
            "720p",
            "1080p"
        ],
        "default": "1080p",
        "label": "Resolution"
    },
    "resolution_wan_move": {
        "type": "select",
        "values": [
            "480p",
            "580p",
            "720p"
        ],
        "default": "480p",
        "label": "Resolution"
    },
    "resolution_wan22": {
        "type": "select",
        "values": [
            "480p",
            "580p",
            "720p"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "duration_wan": {
        "type": "select",
        "values": [
            "5",
            "10",
            "15"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "enable_prompt_expansion": {
        "type": "bool",
        "default": false,
        "label": "Expand Prompt"
    },
    "enable_prompt_expansion_on": {
        "type": "bool",
        "default": true,
        "label": "Expand Prompt"
    },
    "multi_shots": {
        "type": "bool",
        "default": false,
        "label": "Multi Shots"
    },
    "multi_shots_on": {
        "type": "bool",
        "default": true,
        "label": "Multi Shots"
    },
    "audio_url": {
        "type": "text",
        "label": "Audio URL"
    },
    "shift": {
        "type": "number",
        "default": 5,
        "label": "Shift"
    },
    "video_quality": {
        "type": "select",
        "values": [
            "low",
            "medium",
            "high",
            "maximum"
        ],
        "default": "high",
        "label": "Video Quality"
    },
    "video_write_mode": {
        "type": "select",
        "values": [
            "fast",
            "balanced",
            "small"
        ],
        "default": "balanced",
        "label": "Write Mode"
    },
    "return_frames_zip": {
        "type": "bool",
        "default": false,
        "label": "Return Frames ZIP"
    },
    "use_turbo": {
        "type": "bool",
        "default": false,
        "label": "Turbo Mode"
    },
    "num_interpolated_frames": {
        "type": "number",
        "default": 1,
        "label": "Interpolated Frames"
    },
    "acceleration": {
        "type": "select",
        "values": [
            "none",
            "regular"
        ],
        "default": "regular",
        "label": "Acceleration"
    },
    "resample_fps": {
        "type": "bool",
        "default": false,
        "label": "Resample FPS"
    },
    "frames_per_second": {
        "type": "number",
        "label": "Frames Per Second"
    },
    "guidance_scale_wan_move": {
        "type": "number",
        "default": 1,
        "label": "Guidance Scale"
    },
    "guidance_scale_wan22": {
        "type": "number",
        "default": 3.5,
        "label": "Guidance Scale"
    },
    "guidance_scale_2": {
        "type": "number",
        "default": 4,
        "label": "Guidance Scale 2"
    },
    "strength_wan22": {
        "type": "number",
        "default": 0.9,
        "label": "Strength"
    },
    "interpolator_model": {
        "type": "select",
        "values": [
            "none",
            "film",
            "rife"
        ],
        "default": "film",
        "label": "Interpolator"
    },
    "adjust_fps_for_interpolation": {
        "type": "bool",
        "default": true,
        "label": "Adjust FPS for Interpolation"
    },
    "num_inference_steps_wan_move": {
        "type": "number",
        "default": 20,
        "label": "Inference Steps"
    },
    "num_inference_steps_wan22": {
        "type": "number",
        "default": 27,
        "label": "Inference Steps"
    },
    "num_frames": {
        "type": "number",
        "default": 81,
        "label": "Frames"
    },
    "aspect_ratio_pixverse": {
        "type": "select",
        "values": [
            "16:9",
            "4:3",
            "1:1",
            "3:4",
            "9:16"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "resolution_pixverse": {
        "type": "select",
        "values": [
            "360p",
            "540p",
            "720p",
            "1080p"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "duration_pixverse_v5": {
        "type": "select",
        "values": [
            "5",
            "8"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "duration_pixverse_v55": {
        "type": "select",
        "values": [
            "5",
            "8",
            "10"
        ],
        "default": "5",
        "label": "Duration (sec)"
    },
    "style_pixverse": {
        "type": "select",
        "values": [
            "anime",
            "3d_animation",
            "clay",
            "comic",
            "cyberpunk"
        ],
        "default": null,
        "label": "Style",
        "allowEmpty": true,
        "emptyLabel": "Default"
    },
    "thinking_type": {
        "type": "select",
        "values": [
            "enabled",
            "disabled",
            "auto"
        ],
        "default": null,
        "label": "Thinking Type",
        "allowEmpty": true,
        "emptyLabel": "Default"
    },
    "effect_pixverse": {
        "type": "select",
        "values": [
            "Kiss Me AI",
            "Kiss",
            "Muscle Surge",
            "Warmth of Jesus",
            "Anything, Robot",
            "The Tiger Touch",
            "Hug",
            "Holy Wings",
            "Microwave",
            "Zombie Mode",
            "Squid Game",
            "Baby Face",
            "Black Myth: Wukong",
            "Long Hair Magic",
            "Leggy Run",
            "Fin-tastic Mermaid",
            "Punch Face",
            "Creepy Devil Smile",
            "Thunder God",
            "Eye Zoom Challenge",
            "Who's Arrested?",
            "Baby Arrived",
            "Werewolf Rage",
            "Bald Swipe",
            "BOOM DROP",
            "Huge Cutie",
            "Liquid Metal",
            "Sharksnap!",
            "Dust Me Away",
            "3D Figurine Factor",
            "Bikini Up",
            "My Girlfriends",
            "My Boyfriends",
            "Subject 3 Fever",
            "Earth Zoom",
            "Pole Dance",
            "Vroom Dance",
            "GhostFace Terror",
            "Dragon Evoker",
            "Skeletal Bae",
            "Summoning succubus",
            "Halloween Voodoo Doll",
            "3D Naked-Eye AD",
            "Package Explosion",
            "Dishes Served",
            "Ocean ad",
            "Supermarket AD",
            "Tree doll",
            "Come Feel My Abs",
            "The Bicep Flex",
            "London Elite Vibe",
            "Flora Nymph Gown",
            "Christmas Costume",
            "It's Snowy",
            "Reindeer Cruiser",
            "Snow Globe Maker",
            "Pet Christmas Outfit",
            "Adopt a Polar Pal",
            "Cat Christmas Box",
            "Starlight Gift Box",
            "Xmas Poster",
            "Pet Christmas Tree",
            "City Santa Hat",
            "Stocking Sweetie",
            "Christmas Night",
            "Xmas Front Page Karma",
            "Grinch's Xmas Hijack",
            "Giant Product",
            "Truck Fashion Shoot",
            "Beach AD",
            "Shoal Surround",
            "Mechanical Assembly",
            "Lighting AD",
            "Billboard AD",
            "Product close-up",
            "Parachute Delivery",
            "Dreamlike Cloud",
            "Macaron Machine",
            "Poster AD",
            "Truck AD",
            "Graffiti AD",
            "3D Figurine Factory",
            "The Exclusive First Class",
            "Art Zoom Challenge",
            "I Quit",
            "Hitchcock Dolly Zoom",
            "Smell the Lens",
            "I believe I can fly",
            "Strikout Dance",
            "Pixel World",
            "Mint in Box",
            "Hands up, Hand",
            "Flora Nymph Go",
            "Somber Embrace",
            "Beam me up",
            "Suit Swagger"
        ],
        "label": "Effect"
    },
    "generate_audio_switch": {
        "type": "bool",
        "default": false,
        "label": "Generate Audio"
    },
    "generate_multi_clip_switch": {
        "type": "bool",
        "default": false,
        "label": "Multi-Clip"
    },
    "aspect_ratio_lucy": {
        "type": "select",
        "values": [
            "9:16",
            "16:9"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "sync_mode": {
        "type": "bool",
        "default": true,
        "label": "Sync Mode"
    },
    "guidance_scale_ltx_video": {
        "type": "number",
        "default": 3,
        "label": "Guidance Scale"
    },
    "num_inference_steps_ltx_video": {
        "type": "number",
        "default": 30,
        "label": "Inference Steps"
    },
    "aspect_ratio_framepack": {
        "type": "select",
        "values": [
            "16:9",
            "9:16"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "resolution_framepack": {
        "type": "select",
        "values": [
            "720p",
            "480p"
        ],
        "default": "480p",
        "label": "Resolution"
    },
    "num_frames_framepack": {
        "type": "number",
        "default": 180,
        "label": "Frames"
    },
    "guidance_scale_framepack": {
        "type": "number",
        "default": 10,
        "label": "Guidance Scale"
    },
    "duration_hailuo": {
        "type": "select",
        "values": [
            "6",
            "10"
        ],
        "default": "6",
        "label": "Duration (sec)"
    },
    "resolution_hailuo_i2v": {
        "type": "select",
        "values": [
            "512P",
            "768P"
        ],
        "default": "768P",
        "label": "Resolution"
    },
    "prompt_optimizer": {
        "type": "bool",
        "default": true,
        "label": "Optimize Prompt"
    },
    "duration_grok": {
        "type": "select",
        "values": [
            6,
            10,
            15
        ],
        "default": 6,
        "label": "Duration (sec)"
    },
    "aspect_ratio_grok": {
        "type": "select",
        "values": [
            "16:9",
            "4:3",
            "3:2",
            "1:1",
            "2:3",
            "3:4",
            "9:16"
        ],
        "default": "16:9",
        "label": "Aspect Ratio"
    },
    "aspect_ratio_grok_i2v": {
        "type": "select",
        "values": [
            "auto",
            "16:9",
            "4:3",
            "3:2",
            "1:1",
            "2:3",
            "3:4",
            "9:16"
        ],
        "default": null,
        "label": "Aspect Ratio",
        "allowEmpty": true,
        "emptyLabel": "Default"
    },
    "resolution_grok": {
        "type": "select",
        "values": [
            "480p",
            "720p"
        ],
        "default": "720p",
        "label": "Resolution"
    },
    "character_orientation": {
        "type": "select",
        "values": [
            "image",
            "video"
        ],
        "default": "video",
        "label": "Character Orientation"
    },
    "character_orientation_kling3_motion": {
        "type": "select",
        "values": [
            "image",
            "video"
        ],
        "default": "video",
        "label": "Character Orientation"
    },
    "keep_original_sound": {
        "type": "bool",
        "default": true,
        "label": "Keep Original Sound"
    },
    "keep_audio": {
        "type": "bool",
        "default": false,
        "label": "Keep Audio"
    },
    "keep_audio_on": {
        "type": "bool",
        "default": true,
        "label": "Keep Audio"
    },
    "shot_type_v3": {
        "type": "select",
        "values": [
            "customize",
            "intelligent"
        ],
        "default": "customize",
        "label": "Shot Type"
    },
    "shot_type_customize": {
        "type": "select",
        "values": [
            "customize"
        ],
        "default": "customize",
        "label": "Shot Type"
    },
    "first_n_seconds": {
        "type": "number",
        "default": 3,
        "label": "Source Seconds"
    },
    "fps_animatediff": {
        "type": "number",
        "default": 8,
        "label": "FPS"
    },
    "strength_animatediff": {
        "type": "number",
        "default": 0.7,
        "label": "Strength"
    },
    "guidance_scale_animatediff": {
        "type": "number",
        "default": 7.5,
        "label": "Guidance Scale"
    },
    "num_inference_steps_animatediff": {
        "type": "number",
        "default": 25,
        "label": "Inference Steps"
    },
    "motions": {
        "type": "text",
        "label": "Motions (comma separated)"
    },
    "seed": {
        "type": "number",
        "label": "Seed"
    },
    "end_user_id": {
        "type": "text",
        "label": "End User ID"
    }
};

const OPTION_KEY_ALIASES = {
    "aspect_ratio_hunyuan": "aspect_ratio",
    "resolution_hunyuan": "resolution",
    "enable_safety_checker_off": "enable_safety_checker",
    "enable_output_safety_checker_off": "enable_output_safety_checker",
    "num_frames_hunyuan": "num_frames",
    "duration_ltx2": "duration",
    "duration_ltx23_fast": "duration",
    "duration_ltx23_pro": "duration",
    "duration_ltx23_retake": "duration",
    "duration_ltx23_extend": "duration",
    "resolution_ltx2": "resolution",
    "aspect_ratio_ltx23": "aspect_ratio",
    "aspect_ratio_ltx23_i2v": "aspect_ratio",
    "generate_audio_on": "generate_audio",
    "fps_ltx2": "fps",
    "fps_ltx23": "fps",
    "start_time_ltx23": "start_time",
    "retake_mode_ltx23": "retake_mode",
    "extend_mode_ltx23": "mode",
    "context_ltx23": "context",
    "duration_seedance_lite": "duration",
    "duration_seedance_pro": "duration",
    "duration_seedance2": "duration",
    "aspect_ratio_seedance_lite": "aspect_ratio",
    "aspect_ratio_seedance_lite_i2v": "aspect_ratio",
    "aspect_ratio_seedance_pro": "aspect_ratio",
    "aspect_ratio_seedance2_t2v_ref": "aspect_ratio",
    "aspect_ratio_seedance2_i2v": "aspect_ratio",
    "resolution_seedance": "resolution",
    "resolution_seedance2_fast": "resolution",
    "resolution_seedance2_pro": "resolution",
    "aspect_ratio_happy_horse": "aspect_ratio",
    "resolution_happy_horse": "resolution",
    "duration_happy_horse": "duration",
    "aspect_ratio_sora": "aspect_ratio",
    "aspect_ratio_sora_i2v": "aspect_ratio",
    "resolution_sora": "resolution",
    "resolution_sora_i2v": "resolution",
    "duration_sora": "duration",
    "duration_kling": "duration",
    "duration_kling_o1": "duration",
    "duration_kling3": "duration",
    "duration_kling3_optional": "duration",
    "aspect_ratio_kling": "aspect_ratio",
    "aspect_ratio_kling_o1_auto": "aspect_ratio",
    "aspect_ratio_kling_o1_ref": "aspect_ratio",
    "aspect_ratio_kling3": "aspect_ratio",
    "aspect_ratio_o3_v2v": "aspect_ratio",
    "negative_prompt_kling": "negative_prompt",
    "negative_prompt_ltx_video": "negative_prompt",
    "negative_prompt_animatediff": "negative_prompt",
    "duration_veo2": "duration",
    "aspect_ratio_veo31_i2v": "aspect_ratio",
    "aspect_ratio_veo31_ref": "aspect_ratio",
    "resolution_veo31": "resolution",
    "duration_veo31_i2v": "duration",
    "duration_veo31_ref": "duration",
    "safety_tolerance_veo31": "safety_tolerance",
    "aspect_ratio_wan": "aspect_ratio",
    "aspect_ratio_wan22": "aspect_ratio",
    "resolution_wan": "resolution",
    "resolution_wan_move": "resolution",
    "resolution_wan22": "resolution",
    "duration_wan": "duration",
    "enable_prompt_expansion_on": "enable_prompt_expansion",
    "multi_shots_on": "multi_shots",
    "guidance_scale_wan_move": "guidance_scale",
    "guidance_scale_wan22": "guidance_scale",
    "strength_wan22": "strength",
    "num_inference_steps_wan_move": "num_inference_steps",
    "num_inference_steps_wan22": "num_inference_steps",
    "aspect_ratio_pixverse": "aspect_ratio",
    "resolution_pixverse": "resolution",
    "duration_pixverse_v5": "duration",
    "duration_pixverse_v55": "duration",
    "style_pixverse": "style",
    "effect_pixverse": "effect",
    "aspect_ratio_lucy": "aspect_ratio",
    "guidance_scale_ltx_video": "guidance_scale",
    "guidance_scale_ltx23_audio": "guidance_scale",
    "num_inference_steps_ltx_video": "num_inference_steps",
    "aspect_ratio_framepack": "aspect_ratio",
    "resolution_framepack": "resolution",
    "num_frames_framepack": "num_frames",
    "guidance_scale_framepack": "guidance_scale",
    "cfg_scale_framepack": "cfg_scale",
    "resolution_hailuo_i2v": "resolution",
    "duration_hailuo": "duration",
    "duration_grok": "duration",
    "aspect_ratio_grok": "aspect_ratio",
    "aspect_ratio_grok_i2v": "aspect_ratio",
    "resolution_grok": "resolution",
    "keep_audio_on": "keep_audio",
    "shot_type_v3": "shot_type",
    "shot_type_customize": "shot_type",
    "character_orientation_kling3_motion": "character_orientation",
    "fps_animatediff": "fps",
    "strength_animatediff": "strength",
    "guidance_scale_animatediff": "guidance_scale",
    "num_inference_steps_animatediff": "num_inference_steps"
};

const VIDEO_SELECTOR_RANKS = {
    "ltx-2.3-pro-t2v": 91,
    "ltx-2.3-fast-t2v": 92,
    "seedance-2.0-fast-t2v": 93,
    "seedance-2.0-pro-t2v": 94,
    "sora-2-t2v": 101,
    "grok-imagine-t2v": 102,
    "seedance-v1.5-pro-t2v": 103,
    "kling-v2.6-pro-t2v": 104,
    "hailuo-2.3-pro-t2v": 105,
    "wan-v2.6-t2v": 106,
    "ltx-2-t2v-fast": 107,
    "pixverse-v5.5-t2v": 108,
    "hunyuan-video": 109,
    "hailuo-02-pro-t2v": 110,
    "pixverse-v5-t2v": 111,
    "hailuo-2.3-standard-t2v": 112,
    "hailuo-02-standard-t2v": 113,
    "kling-v2.5-turbo-pro-t2v": 114,
    "seedance-v1-lite-t2v": 115,

    "ltx-2.3-pro-i2v": 191,
    "ltx-2.3-fast-i2v": 192,
    "seedance-2.0-fast-i2v": 193,
    "seedance-2.0-pro-i2v": 194,
    "veo3.1-i2v": 201,
    "sora-2-i2v": 202,
    "grok-imagine-i2v": 203,
    "seedance-v1.5-pro-i2v": 204,
    "kling-v2.6-pro-i2v": 205,
    "hailuo-2.3-pro-i2v": 206,
    "wan-v2.6-i2v": 207,
    "veo2-i2v": 208,
    "kling-o1-flfv-pro": 209,
    "pixverse-v5.5-i2v": 210,
    "ltx-video-i2v": 211,
    "framepack-i2v": 212,
    "pixverse-v5.5-effects": 213,
    "hailuo-02-pro-i2v": 214,
    "pixverse-v5-i2v": 215,
    "hailuo-2.3-standard-i2v": 216,
    "hailuo-02-standard-i2v": 217,
    "kling-v2.5-turbo-pro-i2v": 218,
    "seedance-v1-lite-i2v": 219,
    "pixverse-v3.5-i2v": 220,
    "kling-v2.1-standard-i2v": 221,
    "lucy-14b-i2v": 222,

    "ltx-2.3-retake-v2v": 291,
    "ltx-2.3-extend-v2v": 292,
    "sora-2-v2v-remix": 301,
    "kling-o1-v2v-reference": 302,
    "kling-o1-v2v-edit": 303,
    "wan-v2.2-a14b-v2v": 304,
    "kling-v2.6-pro-motion-control": 305,
    "wan-v2.2-14b-animate-move": 306,
    "animatediff-v2v": 307,

    "veo3.1-reference-to-video": 401,
    "seedance-2.0-fast-ref2v": 402,
    "seedance-2.0-pro-ref2v": 403,
    "kling-o1-reference-to-video": 404,
    "happy-horse-ref2v": 405,

    "ltx-2.3-a2v": 451,

    "kling-v3-pro-t2v": 501,
    "kling-o3-pro-t2v": 502,
    "kling-v3-pro-i2v": 511,
    "kling-o3-pro-i2v": 512,
    "kling-v3-pro-motion-control": 521,
    "kling-v3-standard-motion-control": 522,
    "kling-o3-pro-ref2v": 531,
    "kling-o3-pro-v2v-ref": 541,
    "kling-o3-pro-v2v-edit": 542
};

const DEFAULT_VIDEO_SELECTOR_RANK = 10000;
const VIDEO_MODELS = {
    "hunyuan-video": {
        "label": "Hunyuan Video (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/hunyuan-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "aspect_ratio_hunyuan",
            "resolution_hunyuan",
            "enable_safety_checker_off",
            "seed",
            "num_frames_hunyuan",
            "pro_mode"
        ]
    },
    "ltx-2-t2v-fast": {
        "label": "LTX Video 2.0 Fast (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2/text-to-video/fast",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_ltx2",
            "resolution_ltx2",
            "generate_audio_on",
            "fps_ltx2"
        ],
        "optionTypes": {
            "duration_ltx2": "number",
            "fps_ltx2": "number"
        }
    },
    "ltx-2.3-pro-t2v": {
        "label": "LTX 2.3 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2.3/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_ltx23_pro",
            "resolution_ltx2",
            "aspect_ratio_ltx23",
            "fps_ltx23",
            "generate_audio_on"
        ],
        "optionTypes": {
            "duration_ltx23_pro": "number",
            "fps_ltx23": "number"
        }
    },
    "ltx-2.3-fast-t2v": {
        "label": "LTX 2.3 Fast (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2.3/text-to-video/fast",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_ltx23_fast",
            "resolution_ltx2",
            "aspect_ratio_ltx23",
            "fps_ltx23",
            "generate_audio_on"
        ],
        "optionTypes": {
            "duration_ltx23_fast": "number",
            "fps_ltx23": "number"
        }
    },
    "seedance-2.0-fast-t2v": {
        "label": "Seedance 2.0 Fast (Text to Video)",
        "endpoint": "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "resolution_seedance2_fast",
            "duration_seedance2",
            "aspect_ratio_seedance2_t2v_ref",
            "generate_audio_on",
            "seed",
            "end_user_id"
        ]
    },
    "seedance-2.0-pro-t2v": {
        "label": "Seedance 2.0 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/bytedance/seedance-2.0/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "resolution_seedance2_pro",
            "duration_seedance2",
            "aspect_ratio_seedance2_t2v_ref",
            "generate_audio_on",
            "seed",
            "end_user_id"
        ]
    },
    "seedance-v1-lite-t2v": {
        "label": "Seedance 1.0 Lite (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/bytedance/seedance/v1/lite/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_seedance_lite",
            "aspect_ratio_seedance_lite",
            "resolution_seedance",
            "enable_safety_checker",
            "seed",
            "camera_fixed"
        ]
    },
    "seedance-v1.5-pro-t2v": {
        "label": "Seedance 1.5 Pro (Text to Video + Audio)",
        "endpoint": "https://queue.fal.run/fal-ai/bytedance/seedance/v1.5/pro/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_seedance_pro",
            "resolution_seedance",
            "generate_audio_on",
            "aspect_ratio_seedance_pro",
            "enable_safety_checker",
            "seed",
            "camera_fixed"
        ]
    },
    "sora-2-t2v": {
        "label": "Sora 2 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/sora-2/text-to-video/pro",
        "kind": "text-to-video",
        "allowedOptions": [
            "aspect_ratio_sora",
            "resolution_sora",
            "duration_sora",
            "delete_video",
            "detect_and_block_ip"
        ],
        "optionTypes": {
            "duration_sora": "number"
        }
    },
    "kling-v2.6-pro-t2v": {
        "label": "Kling 2.6 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v2.6/pro/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_kling",
            "aspect_ratio_kling",
            "negative_prompt_kling",
            "cfg_scale",
            "generate_audio_on"
        ]
    },
    "kling-v2.5-turbo-pro-t2v": {
        "label": "Kling 2.5 Turbo Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_kling",
            "aspect_ratio_kling",
            "negative_prompt_kling",
            "cfg_scale"
        ]
    },
    "wan-v2.6-t2v": {
        "label": "Wan v2.6 (Text to Video)",
        "endpoint": "https://queue.fal.run/wan/v2.6/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "aspect_ratio_wan",
            "resolution_wan",
            "duration_wan",
            "negative_prompt",
            "enable_prompt_expansion_on",
            "multi_shots_on",
            "enable_safety_checker",
            "seed",
            "audio_url"
        ]
    },
    "pixverse-v5-t2v": {
        "label": "PixVerse v5 (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/pixverse/v5/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "aspect_ratio_pixverse",
            "resolution_pixverse",
            "duration_pixverse_v5",
            "negative_prompt",
            "style_pixverse",
            "seed"
        ]
    },
    "pixverse-v5.5-t2v": {
        "label": "PixVerse v5.5 (Text to Video + Audio + Multi-Clip)",
        "endpoint": "https://queue.fal.run/fal-ai/pixverse/v5.5/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "aspect_ratio_pixverse",
            "resolution_pixverse",
            "duration_pixverse_v55",
            "negative_prompt",
            "style_pixverse",
            "seed",
            "generate_audio_switch",
            "generate_multi_clip_switch",
            "thinking_type"
        ]
    },
    "hailuo-02-standard-t2v": {
        "label": "Hailuo-02 Standard (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-02/standard/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_hailuo",
            "prompt_optimizer"
        ]
    },
    "hailuo-02-pro-t2v": {
        "label": "Hailuo-02 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-02/pro/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "prompt_optimizer"
        ]
    },
    "grok-imagine-t2v": {
        "label": "Grok Imagine (Text to Video)",
        "endpoint": "https://queue.fal.run/xai/grok-imagine-video/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_grok",
            "aspect_ratio_grok",
            "resolution_grok"
        ],
        "optionTypes": {
            "duration_grok": "number"
        }
    },
    "kling-v2.1-standard-i2v": {
        "label": "Kling 2.1 Standard (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v2.1/standard/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "duration_kling",
            "negative_prompt_kling",
            "cfg_scale"
        ]
    },
    "kling-o1-flfv-pro": {
        "label": "Kling O1 (First Frame -> Last Frame) [Pro]",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o1/image-to-video",
        "kind": "image-to-video",
        "startImageParam": "start_image_url",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "duration_kling_o1"
        ]
    },
    "kling-v2.6-pro-i2v": {
        "label": "Kling 2.6 Pro (Image to Video + Audio + Voice)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video",
        "kind": "image-to-video",
        "startImageParam": "start_image_url",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "duration_kling",
            "negative_prompt_kling",
            "generate_audio_on",
            "voice_ids"
        ]
    },
    "kling-v2.5-turbo-pro-i2v": {
        "label": "Kling 2.5 Turbo Pro (Image to Video, Tail Frame)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "tail_image_url",
        "allowedOptions": [
            "duration_kling",
            "negative_prompt_kling",
            "cfg_scale"
        ]
    },
    "veo2-i2v": {
        "label": "Veo 2 (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/veo2/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "duration_veo2"
        ]
    },
    "veo3.1-i2v": {
        "label": "Veo 3.1 (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/veo3.1/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "aspect_ratio_veo31_i2v",
            "duration_veo31_i2v",
            "negative_prompt",
            "resolution_veo31",
            "generate_audio_on",
            "seed",
            "auto_fix",
            "safety_tolerance_veo31"
        ]
    },
    "sora-2-i2v": {
        "label": "Sora 2 Pro (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/sora-2/image-to-video/pro",
        "kind": "image-to-video",
        "allowedOptions": [
            "aspect_ratio_sora_i2v",
            "resolution_sora_i2v",
            "duration_sora",
            "delete_video",
            "detect_and_block_ip"
        ],
        "optionTypes": {
            "duration_sora": "number"
        }
    },
    "wan-v2.6-i2v": {
        "label": "Wan v2.6 (Image to Video)",
        "endpoint": "https://queue.fal.run/wan/v2.6/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "resolution_wan",
            "duration_wan",
            "negative_prompt",
            "enable_prompt_expansion_on",
            "multi_shots",
            "enable_safety_checker",
            "seed",
            "audio_url"
        ]
    },
    "pixverse-v5-i2v": {
        "label": "PixVerse v5 (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/pixverse/v5/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "resolution_pixverse",
            "duration_pixverse_v5",
            "negative_prompt",
            "style_pixverse",
            "seed"
        ]
    },
    "pixverse-v5.5-i2v": {
        "label": "PixVerse v5.5 (Image to Video + Audio + Multi-Clip)",
        "endpoint": "https://queue.fal.run/fal-ai/pixverse/v5.5/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "resolution_pixverse",
            "duration_pixverse_v55",
            "negative_prompt",
            "style_pixverse",
            "seed",
            "generate_audio_switch",
            "generate_multi_clip_switch",
            "thinking_type"
        ]
    },
    "pixverse-v5.5-effects": {
        "label": "PixVerse v5.5 Effects",
        "endpoint": "https://queue.fal.run/fal-ai/pixverse/v5.5/effects",
        "kind": "image-to-video",
        "requiresPrompt": false,
        "allowedOptions": [
            "effect_pixverse",
            "resolution_pixverse",
            "duration_pixverse_v55",
            "negative_prompt",
            "thinking_type"
        ]
    },
    "lucy-14b-i2v": {
        "label": "Lucy-14B (Image to Video)",
        "endpoint": "https://queue.fal.run/decart/lucy-14b/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "aspect_ratio_lucy",
            "sync_mode"
        ]
    },
    "ltx-video-i2v": {
        "label": "LTX Video (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-video/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "negative_prompt_ltx_video",
            "seed",
            "num_inference_steps_ltx_video",
            "guidance_scale_ltx_video"
        ]
    },
    "ltx-2.3-pro-i2v": {
        "label": "LTX 2.3 Pro (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2.3/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "duration_ltx23_pro",
            "resolution_ltx2",
            "aspect_ratio_ltx23_i2v",
            "fps_ltx23",
            "generate_audio_on"
        ],
        "optionTypes": {
            "duration_ltx23_pro": "number",
            "fps_ltx23": "number"
        }
    },
    "ltx-2.3-fast-i2v": {
        "label": "LTX 2.3 Fast (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2.3/image-to-video/fast",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "duration_ltx23_fast",
            "resolution_ltx2",
            "aspect_ratio_ltx23_i2v",
            "fps_ltx23",
            "generate_audio_on"
        ],
        "optionTypes": {
            "duration_ltx23_fast": "number",
            "fps_ltx23": "number"
        }
    },
    "seedance-2.0-fast-i2v": {
        "label": "Seedance 2.0 Fast (Image to Video)",
        "endpoint": "https://queue.fal.run/bytedance/seedance-2.0/fast/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "resolution_seedance2_fast",
            "duration_seedance2",
            "aspect_ratio_seedance2_i2v",
            "generate_audio_on",
            "seed",
            "end_user_id"
        ]
    },
    "seedance-2.0-pro-i2v": {
        "label": "Seedance 2.0 Pro (Image to Video)",
        "endpoint": "https://queue.fal.run/bytedance/seedance-2.0/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "resolution_seedance2_pro",
            "duration_seedance2",
            "aspect_ratio_seedance2_i2v",
            "generate_audio_on",
            "seed",
            "end_user_id"
        ]
    },
    "framepack-i2v": {
        "label": "Framepack (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/framepack",
        "kind": "image-to-video",
        "allowedOptions": [
            "aspect_ratio_framepack",
            "resolution_framepack",
            "num_frames_framepack",
            "enable_safety_checker_off",
            "seed",
            "guidance_scale_framepack",
            "negative_prompt",
            "cfg_scale_framepack"
        ]
    },
    "pixverse-v3.5-i2v": {
        "label": "PixVerse v3.5 (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/pixverse/v3.5/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "resolution_pixverse",
            "duration_pixverse_v5",
            "negative_prompt",
            "style_pixverse",
            "seed"
        ]
    },
    "seedance-v1-lite-i2v": {
        "label": "Seedance 1.0 Lite (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/bytedance/seedance/v1/lite/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "duration_seedance_lite",
            "resolution_seedance",
            "aspect_ratio_seedance_lite_i2v",
            "enable_safety_checker",
            "seed",
            "camera_fixed"
        ]
    },
    "seedance-v1.5-pro-i2v": {
        "label": "Seedance 1.5 Pro (Image to Video + Audio, End Frame)",
        "endpoint": "https://queue.fal.run/fal-ai/bytedance/seedance/v1.5/pro/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "duration_seedance_pro",
            "resolution_seedance",
            "generate_audio_on",
            "aspect_ratio_seedance_pro",
            "enable_safety_checker",
            "seed",
            "camera_fixed"
        ]
    },
    "hailuo-02-standard-i2v": {
        "label": "Hailuo-02 Standard (Image to Video, End Frame)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-02/standard/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "duration_hailuo",
            "resolution_hailuo_i2v",
            "prompt_optimizer"
        ]
    },
    "hailuo-02-pro-i2v": {
        "label": "Hailuo-02 Pro (Image to Video, End Frame)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-02/pro/image-to-video",
        "kind": "image-to-video",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "allowedOptions": [
            "prompt_optimizer"
        ]
    },
    "hailuo-2.3-pro-i2v": {
        "label": "Hailuo 2.3 Pro (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-2.3/pro/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "prompt_optimizer"
        ]
    },
    "hailuo-2.3-pro-t2v": {
        "label": "Hailuo 2.3 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-2.3/pro/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "prompt_optimizer"
        ]
    },
    "hailuo-2.3-standard-t2v": {
        "label": "Hailuo 2.3 Standard (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-2.3/standard/text-to-video",
        "kind": "text-to-video",
        "allowedOptions": [
            "duration_hailuo",
            "prompt_optimizer"
        ]
    },
    "hailuo-2.3-standard-i2v": {
        "label": "Hailuo 2.3 Standard (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/minimax/hailuo-2.3/standard/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "duration_hailuo",
            "prompt_optimizer"
        ]
    },
    "grok-imagine-i2v": {
        "label": "Grok Imagine (Image to Video)",
        "endpoint": "https://queue.fal.run/xai/grok-imagine-video/image-to-video",
        "kind": "image-to-video",
        "allowedOptions": [
            "duration_grok",
            "aspect_ratio_grok_i2v",
            "resolution_grok"
        ],
        "optionTypes": {
            "duration_grok": "number"
        }
    },
    "kling-o1-v2v-reference": {
        "label": "Kling O1 (Video to Video - Reference)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o1/video-to-video/reference",
        "kind": "video-to-video",
        "allowedOptions": [
            "aspect_ratio_kling_o1_auto",
            "duration_kling_o1",
            "keep_audio"
        ]
    },
    "kling-o1-v2v-edit": {
        "label": "Kling O1 (Video to Video - Edit) [Pro]",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o1/video-to-video/edit",
        "kind": "video-to-video",
        "allowedOptions": [
            "keep_audio"
        ]
    },
    "kling-v2.6-pro-motion-control": {
        "label": "Kling 2.6 Pro (Motion Control: Image + Video -> Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v2.6/pro/motion-control",
        "kind": "motion-control",
        "requiresPrompt": false,
        "usesImageUrls": false,
        "allowedOptions": [
            "character_orientation",
            "keep_original_sound"
        ]
    },
    "wan-v2.2-14b-animate-move": {
        "label": "Wan 2.2 14B Animate Move (Image + Video -> Video)",
        "endpoint": "https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/move",
        "kind": "motion-control",
        "requiresPrompt": false,
        "usesImageUrls": false,
        "allowedOptions": [
            "guidance_scale_wan_move",
            "resolution_wan_move",
            "seed",
            "num_inference_steps_wan_move",
            "enable_safety_checker_off",
            "enable_output_safety_checker_off",
            "shift",
            "video_quality",
            "video_write_mode",
            "return_frames_zip",
            "use_turbo"
        ]
    },
    "wan-v2.2-a14b-v2v": {
        "label": "Wan 2.2 A14B (Video to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/wan/v2.2-a14b/video-to-video",
        "kind": "video-to-video",
        "allowedOptions": [
            "num_interpolated_frames",
            "acceleration",
            "shift",
            "resample_fps",
            "frames_per_second",
            "guidance_scale_wan22",
            "num_frames",
            "enable_safety_checker_off",
            "negative_prompt",
            "video_write_mode",
            "aspect_ratio_wan22",
            "resolution_wan22",
            "enable_output_safety_checker_off",
            "guidance_scale_2",
            "video_quality",
            "strength_wan22",
            "enable_prompt_expansion",
            "seed",
            "interpolator_model",
            "adjust_fps_for_interpolation",
            "num_inference_steps_wan22"
        ]
    },
    "animatediff-v2v": {
        "label": "AnimateDiff (Video to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/fast-animatediff/video-to-video",
        "kind": "video-to-video",
        "allowedOptions": [
            "first_n_seconds",
            "fps_animatediff",
            "strength_animatediff",
            "guidance_scale_animatediff",
            "num_inference_steps_animatediff",
            "seed",
            "negative_prompt_animatediff",
            "motions"
        ]
    },
    "ltx-2.3-retake-v2v": {
        "label": "LTX 2.3 Retake (Video to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2.3/retake-video",
        "kind": "video-to-video",
        "usesImageUrls": false,
        "allowedOptions": [
            "start_time_ltx23",
            "duration_ltx23_retake",
            "retake_mode_ltx23"
        ]
    },
    "ltx-2.3-extend-v2v": {
        "label": "LTX 2.3 Extend (Video to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2.3/extend-video",
        "kind": "video-to-video",
        "requiresPrompt": false,
        "usesImageUrls": false,
        "allowedOptions": [
            "duration_ltx23_extend",
            "extend_mode_ltx23",
            "context_ltx23"
        ]
    },
    "sora-2-v2v-remix": {
        "label": "Sora 2 (Video to Video - Remix)",
        "endpoint": "https://queue.fal.run/fal-ai/sora-2/video-to-video/remix",
        "kind": "video-id-to-video",
        "allowedOptions": [
            "delete_video"
        ]
    },
    "ltx-2.3-a2v": {
        "label": "LTX 2.3 (Audio to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/ltx-2.3/audio-to-video",
        "kind": "audio-to-video",
        "requiresPrompt": false,
        "requiresImage": false,
        "startImageParam": "image_url",
        "allowedOptions": [
            "audio_url",
            "guidance_scale_ltx23_audio"
        ]
    },
    "seedance-2.0-fast-ref2v": {
        "label": "Seedance 2.0 Fast (Reference to Video)",
        "endpoint": "https://queue.fal.run/bytedance/seedance-2.0/fast/reference-to-video",
        "kind": "reference-to-video",
        "requiresImage": false,
        "supportsVideoUrls": true,
        "supportsAudioUrls": true,
        "maxImageUrls": 9,
        "maxVideoUrls": 3,
        "maxAudioUrls": 3,
        "maxTotalReferences": 12,
        "allowedOptions": [
            "resolution_seedance2_fast",
            "duration_seedance2",
            "aspect_ratio_seedance2_t2v_ref",
            "generate_audio_on",
            "seed",
            "end_user_id"
        ]
    },
    "seedance-2.0-pro-ref2v": {
        "label": "Seedance 2.0 Pro (Reference to Video)",
        "endpoint": "https://queue.fal.run/bytedance/seedance-2.0/reference-to-video",
        "kind": "reference-to-video",
        "requiresImage": false,
        "supportsVideoUrls": true,
        "supportsAudioUrls": true,
        "maxImageUrls": 9,
        "maxVideoUrls": 3,
        "maxAudioUrls": 3,
        "maxTotalReferences": 12,
        "allowedOptions": [
            "resolution_seedance2_pro",
            "duration_seedance2",
            "aspect_ratio_seedance2_t2v_ref",
            "generate_audio_on",
            "seed",
            "end_user_id"
        ]
    },
    "kling-o1-reference-to-video": {
        "label": "Kling O1 (Reference to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o1/reference-to-video",
        "kind": "reference-to-video",
        "allowedOptions": [
            "aspect_ratio_kling_o1_ref",
            "duration_kling_o1"
        ]
    },
    "happy-horse-ref2v": {
        "label": "Happy Horse (Reference to Video)",
        "endpoint": "https://queue.fal.run/alibaba/happy-horse/reference-to-video",
        "kind": "reference-to-video",
        "requiresImage": false,
        "maxImageUrls": 9,
        "allowedOptions": [
            "aspect_ratio_happy_horse",
            "resolution_happy_horse",
            "duration_happy_horse",
            "enable_safety_checker",
            "seed"
        ],
        "optionTypes": {
            "duration_happy_horse": "number"
        }
    },
    "veo3.1-reference-to-video": {
        "label": "Veo 3.1 (Reference to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/veo3.1/reference-to-video",
        "kind": "reference-to-video",
        "allowedOptions": [
            "duration_veo31_ref",
            "resolution_veo31",
            "generate_audio_on",
            "auto_fix",
            "aspect_ratio_veo31_ref",
            "safety_tolerance_veo31"
        ]
    },
    "kling-v3-pro-t2v": {
        "label": "Kling 3.0 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v3/pro/text-to-video",
        "kind": "kling3-text-to-video",
        "requiresPrompt": true,
        "requiresImage": false,
        "supportsMultiPrompt": true,
        "allowedOptions": [
            "duration_kling3",
            "aspect_ratio_kling3",
            "shot_type_v3",
            "cfg_scale",
            "negative_prompt_kling",
            "generate_audio_on",
            "voice_ids"
        ]
    },
    "kling-v3-pro-i2v": {
        "label": "Kling 3.0 Pro (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video",
        "kind": "kling3-image-to-video",
        "requiresPrompt": false,
        "requiresImage": true,
        "startImageParam": "start_image_url",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "supportsMultiPrompt": true,
        "supportsElements": true,
        "allowedOptions": [
            "duration_kling3",
            "aspect_ratio_kling3",
            "shot_type_customize",
            "cfg_scale",
            "negative_prompt_kling",
            "generate_audio_on",
            "voice_ids"
        ]
    },
    "kling-v3-standard-motion-control": {
        "label": "Kling 3.0 Standard (Motion Control)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v3/standard/motion-control",
        "kind": "kling3-motion-control",
        "requiresPrompt": false,
        "requiresImage": true,
        "usesImageUrls": false,
        "supportsElements": true,
        "addedAt": "2026-03-05T00:00:00.000Z",
        "newsDescriptionKey": "news_desc_kling_v3_standard_motion",
        "newsDescription": "Transfer motion from a reference video to any character image.",
        "allowedOptions": [
            "character_orientation_kling3_motion",
            "keep_original_sound"
        ]
    },
    "kling-v3-pro-motion-control": {
        "label": "Kling 3.0 Pro (Motion Control)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/v3/pro/motion-control",
        "kind": "kling3-motion-control",
        "requiresPrompt": false,
        "requiresImage": true,
        "usesImageUrls": false,
        "supportsElements": true,
        "addedAt": "2026-03-05T00:00:00.000Z",
        "newsDescriptionKey": "news_desc_kling_v3_pro_motion",
        "newsDescription": "Pro-quality motion transfer with stronger fidelity for complex movement.",
        "allowedOptions": [
            "character_orientation_kling3_motion",
            "keep_original_sound"
        ]
    },
    "kling-o3-pro-t2v": {
        "label": "Kling O3 Pro (Text to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o3/pro/text-to-video",
        "kind": "kling3-text-to-video",
        "requiresPrompt": true,
        "requiresImage": false,
        "supportsMultiPrompt": true,
        "allowedOptions": [
            "duration_kling3",
            "aspect_ratio_kling3",
            "shot_type_customize",
            "generate_audio",
            "voice_ids"
        ]
    },
    "kling-o3-pro-i2v": {
        "label": "Kling O3 Pro (Image to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o3/pro/image-to-video",
        "kind": "kling3-image-to-video",
        "requiresPrompt": false,
        "requiresImage": true,
        "startImageParam": "image_url",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "supportsMultiPrompt": true,
        "allowedOptions": [
            "duration_kling3",
            "shot_type_customize",
            "generate_audio"
        ]
    },
    "kling-o3-pro-ref2v": {
        "label": "Kling O3 Pro (Reference to Video)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o3/pro/reference-to-video",
        "kind": "kling3-reference-to-video",
        "requiresPrompt": true,
        "requiresImage": true,
        "startImageParam": "start_image_url",
        "supportsEndImage": true,
        "endImageParam": "end_image_url",
        "supportsElements": true,
        "allowedOptions": [
            "duration_kling3",
            "aspect_ratio_kling3",
            "shot_type_customize",
            "generate_audio"
        ]
    },
    "kling-o3-pro-v2v-edit": {
        "label": "Kling O3 Pro (V2V Edit)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o3/pro/video-to-video/edit",
        "kind": "kling3-video-to-video",
        "requiresPrompt": true,
        "requiresImage": false,
        "supportsElements": true,
        "allowedOptions": [
            "keep_audio_on",
            "shot_type_customize"
        ]
    },
    "kling-o3-pro-v2v-ref": {
        "label": "Kling O3 Pro (V2V Reference)",
        "endpoint": "https://queue.fal.run/fal-ai/kling-video/o3/pro/video-to-video/reference",
        "kind": "kling3-video-to-video",
        "requiresPrompt": true,
        "requiresImage": false,
        "supportsElements": true,
        "allowedOptions": [
            "duration_kling3_optional",
            "aspect_ratio_o3_v2v",
            "shot_type_customize",
            "keep_audio_on"
        ]
    }
};

for (const [id, model] of Object.entries(VIDEO_MODELS)) {
    model.selectorRank = Object.prototype.hasOwnProperty.call(VIDEO_SELECTOR_RANKS, id)
        ? VIDEO_SELECTOR_RANKS[id]
        : DEFAULT_VIDEO_SELECTOR_RANK;
}

const config = {
    api: {
        bodyParser: false, // Disable default body parsing for file uploads
    },
};

async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

// Helper to parse multipart form data
async function parseFormData(req) {
    const busboy = require('busboy');

    return new Promise((resolve, reject) => {
        const fields = {};
        let videoFile = null;
        let endImageFile = null;
        let audioFile = null;
        const imageFiles = [];

        const bb = busboy({ headers: req.headers });

        bb.on('file', (name, file, info) => {
            const { filename, mimeType } = info;
            const chunks = [];

            file.on('data', (data) => {
                chunks.push(data);
            });

            file.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (!buffer || buffer.length === 0) return;

                if (name === 'video') {
                    videoFile = {
                        buffer,
                        filename,
                        mimeType,
                    };
                    return;
                }

                if (name === 'end_image' || name === 'endImage') {
                    endImageFile = {
                        buffer,
                        filename,
                        mimeType,
                    };
                    return;
                }

                if (name === 'audio') {
                    audioFile = {
                        buffer,
                        filename,
                        mimeType,
                    };
                    return;
                }

                if (name === 'image' || name === 'images') {
                    imageFiles.push({
                        buffer,
                        filename,
                        mimeType,
                    });
                }
            });
        });

        bb.on('field', (name, val) => {
            fields[name] = val;
        });

        bb.on('close', () => {
            resolve({
                fields,
                videoFile,
                endImageFile,
                audioFile,
                imageFiles,
            });
        });

        bb.on('error', reject);

        req.pipe(bb);
    });
}

// Upload file to fal.ai storage
async function uploadToFal(fileBuffer, fileName, mimeType) {
    return uploadBufferToFal(fileBuffer, fileName, mimeType);
}

module.exports = async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (!requireAuth(req, res)) {
        return;
    }

    // GET = return models list (was video-models.js)
    if (req.method === 'GET') {
        try {
            const models = Object.entries(VIDEO_MODELS).map(([id, m]) => ({
                id,
                label: m && m.label ? m.label : id,
                kind: m && m.kind ? m.kind : null,
                allowedOptions: Array.isArray(m && m.allowedOptions) ? m.allowedOptions : [],
                optionTypes: (m && m.optionTypes && typeof m.optionTypes === 'object') ? m.optionTypes : null,
                requiresPrompt: (m && Object.prototype.hasOwnProperty.call(m, 'requiresPrompt')) ? m.requiresPrompt : true,
                requiresImage: (m && Object.prototype.hasOwnProperty.call(m, 'requiresImage')) ? m.requiresImage : true,
                usesImageUrls: (m && Object.prototype.hasOwnProperty.call(m, 'usesImageUrls')) ? m.usesImageUrls : true,
                supportsVideoUrls: !!(m && m.supportsVideoUrls),
                supportsAudioUrls: !!(m && m.supportsAudioUrls),
                maxImageUrls: (m && typeof m.maxImageUrls === 'number') ? m.maxImageUrls : null,
                maxVideoUrls: (m && typeof m.maxVideoUrls === 'number') ? m.maxVideoUrls : null,
                maxAudioUrls: (m && typeof m.maxAudioUrls === 'number') ? m.maxAudioUrls : null,
                maxTotalReferences: (m && typeof m.maxTotalReferences === 'number') ? m.maxTotalReferences : null,
                supportsEndImage: !!(m && m.supportsEndImage),
                startImageParam: m && m.startImageParam ? m.startImageParam : null,
                endImageParam: m && m.endImageParam ? m.endImageParam : null,
                addedAt: m && m.addedAt ? m.addedAt : null,
                newsDescription: m && m.newsDescription ? m.newsDescription : '',
                newsDescriptionKey: m && m.newsDescriptionKey ? m.newsDescriptionKey : null,
                selectorRank: (m && typeof m.selectorRank === 'number') ? m.selectorRank : DEFAULT_VIDEO_SELECTOR_RANK,
            }));
            models.sort((a, b) => {
                const rankDiff = (a.selectorRank || DEFAULT_VIDEO_SELECTOR_RANK) - (b.selectorRank || DEFAULT_VIDEO_SELECTOR_RANK);
                if (rankDiff !== 0) return rankDiff;
                return String(a.label).localeCompare(String(b.label));
            });
            return res.status(200).json({ models, optionDefs: OPTION_DEFS });
        } catch (e) {
            return res.status(500).json({ error: e && e.message ? e.message : 'Internal server error' });
        }
    }

    // Only allow POST for generation
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const contentType = (req.headers['content-type'] || '').toLowerCase();

        let model_id;
        let prompt;
        let multi_prompt;
        let duration;
        let aspect_ratio;
        let keep_audio;
        let video_id;
        let video_url;
        let image_url;
        let start_image_url;
        let end_image_url;
        let tail_image_url;
        let image_urls;
        let video_urls;
        let audio_urls;
        let elements;
        let videoFile;
        let endImageFile;
        let audioFile;
        let imageFiles;
        let options;

        if (contentType.includes('application/json')) {
            const body = await readJsonBody(req);
            model_id = body.model_id;
            prompt = body.prompt;
            multi_prompt = body.multi_prompt;
            duration = body.duration;
            aspect_ratio = body.aspect_ratio;
            keep_audio = body.keep_audio;
            video_id = body.video_id;
            video_url = body.video_url;
            image_url = body.image_url;
            start_image_url = body.start_image_url;
            end_image_url = body.end_image_url;
            tail_image_url = body.tail_image_url;
            image_urls = body.image_urls;
            video_urls = body.video_urls;
            audio_urls = body.audio_urls;
            elements = body.elements;
            options = body.options;
            // Handle audio_url from body
            if (body.audio_url) {
                if (!options) options = {};
                options.audio_url = body.audio_url;
            }
            videoFile = null;
            endImageFile = null;
            audioFile = null;
            imageFiles = [];
        } else {
            const parsed = await parseFormData(req);
            const fields = parsed.fields || {};
            videoFile = parsed.videoFile;
            endImageFile = parsed.endImageFile;
            audioFile = parsed.audioFile;
            imageFiles = parsed.imageFiles || [];

            model_id = fields.model_id;
            prompt = fields.prompt;
            duration = fields.duration;
            aspect_ratio = fields.aspect_ratio;
            keep_audio = fields.keep_audio;
            video_id = fields.video_id;
            video_url = fields.video_url;
            image_url = fields.image_url;
            start_image_url = fields.start_image_url;
            end_image_url = fields.end_image_url;
            tail_image_url = fields.tail_image_url;

            if (fields.image_urls) {
                try {
                    image_urls = JSON.parse(fields.image_urls);
                } catch {
                    image_urls = null;
                }
            }

            if (fields.video_urls) {
                try {
                    video_urls = JSON.parse(fields.video_urls);
                } catch {
                    video_urls = null;
                }
            }

            if (fields.audio_urls) {
                try {
                    audio_urls = JSON.parse(fields.audio_urls);
                } catch {
                    audio_urls = null;
                }
            }

            if (fields.elements) {
                try {
                    elements = JSON.parse(fields.elements);
                } catch {
                    elements = null;
                }
            }

            if (fields.options) {
                try {
                    options = JSON.parse(fields.options);
                } catch {
                    options = null;
                }
            }

            if (fields.audio_url) {
                if (!options) options = {};
                options.audio_url = fields.audio_url;
            }
        }

        const selectedModel = VIDEO_MODELS[model_id] || VIDEO_MODELS['kling-o1-v2v-reference'];
        const supportsReferenceVideos = !!selectedModel.supportsVideoUrls;
        const supportsReferenceAudios = !!selectedModel.supportsAudioUrls;
        const isSeedanceReferenceModel = selectedModel.kind === 'reference-to-video' && (supportsReferenceVideos || supportsReferenceAudios);

        if (!selectedModel) {
            return res.status(400).json({ error: 'Unknown model_id' });
        }

        if (!FAL_API_KEY && (!getGoogleVideoModelId(model_id) || !hasGoogleApiKey())) {
            return res.status(500).json({ error: 'FAL_KEY environment variable not configured' });
        }

        // For Kling 3 models, either prompt or multi_prompt is required (except motion-control where prompt is optional)
        const isKling3Model = selectedModel.kind && selectedModel.kind.startsWith('kling3-');
        const isKling3MotionControl = selectedModel.kind === 'kling3-motion-control';
        if (isKling3Model && !isKling3MotionControl) {
            if (!prompt && !multi_prompt) {
                return res.status(400).json({ error: 'Either prompt or multi_prompt is required' });
            }
            if (prompt && multi_prompt) {
                return res.status(400).json({ error: 'Cannot use both prompt and multi_prompt - choose one' });
            }
        } else if (selectedModel.requiresPrompt !== false && !prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        if (!image_url && start_image_url) {
            image_url = start_image_url;
        }

        let finalVideoUrl = null;
        let finalImageUrl = null;

        if (selectedModel.kind === 'video-to-video' || selectedModel.kind === 'motion-control' || selectedModel.kind === 'kling3-video-to-video' || selectedModel.kind === 'kling3-motion-control') {
            finalVideoUrl = video_url || null;
            if (!finalVideoUrl && videoFile) {
                finalVideoUrl = await uploadToFal(videoFile.buffer, videoFile.filename, videoFile.mimeType);
            }
            if (!finalVideoUrl) {
                return res.status(400).json({ error: 'video_url or video file is required for this model' });
            }
        }

        if (
            selectedModel.kind === 'image-to-video'
            || selectedModel.kind === 'audio-to-video'
            || selectedModel.kind === 'motion-control'
            || selectedModel.kind === 'kling3-image-to-video'
            || selectedModel.kind === 'kling3-reference-to-video'
            || selectedModel.kind === 'kling3-motion-control'
            || (selectedModel.kind === 'reference-to-video' && selectedModel.requiresImage !== false)
        ) {
            finalImageUrl = image_url || null;

            if (!finalImageUrl && Array.isArray(imageFiles) && imageFiles.length > 0) {
                const first = imageFiles[0];
                finalImageUrl = await uploadToFal(first.buffer, first.filename, first.mimeType);
            }

            if (!finalImageUrl && Array.isArray(image_urls) && image_urls.length > 0) {
                const first = image_urls.find((u) => typeof u === 'string' && u);
                if (first) finalImageUrl = first;
            }

            if (selectedModel.requiresImage !== false && !finalImageUrl) {
                return res.status(400).json({ error: 'image_url or image file is required for this model' });
            }
        }

        if (selectedModel.kind === 'audio-to-video') {
            if ((!options || typeof options.audio_url !== 'string' || !options.audio_url) && audioFile) {
                if (!options) options = {};
                options.audio_url = await uploadToFal(audioFile.buffer, audioFile.filename, audioFile.mimeType);
            }
            const providedAudioUrl =
                (options && typeof options === 'object' && typeof options.audio_url === 'string' && options.audio_url)
                    ? options.audio_url
                    : null;

            if (!providedAudioUrl) {
                return res.status(400).json({ error: 'audio_url is required for this model' });
            }

            if (!prompt && !finalImageUrl) {
                return res.status(400).json({ error: 'Prompt is required when no image is provided for this model' });
            }
        }

        if (selectedModel.kind === 'motion-control' || selectedModel.kind === 'kling3-motion-control') {
            // Motion-control requires both image and video.
            if (!finalVideoUrl) {
                return res.status(400).json({ error: 'video_url or video file is required for this model' });
            }
            if (!finalImageUrl) {
                return res.status(400).json({ error: 'image_url or image file is required for this model' });
            }
        }

        if (selectedModel.kind === 'reference-to-video' && !isSeedanceReferenceModel) {
            // Kling O1 reference-to-video expects start image + optional style references in image_urls,
            // and optional elements. We require at least one image.
            const hasAnyImageUrl =
                (typeof image_url === 'string' && image_url) ||
                (Array.isArray(image_urls) && image_urls.some((u) => typeof u === 'string' && u)) ||
                (Array.isArray(imageFiles) && imageFiles.length > 0);

            if (!hasAnyImageUrl) {
                return res.status(400).json({ error: 'At least one image (start frame) is required for this model' });
            }
        }

        const uploadedImageUrls = [];
        const uploadedVideoUrls = [];
        const uploadedAudioUrls = [];
        const shouldProcessImageUrls =
            (selectedModel.kind === 'video-to-video' || selectedModel.kind === 'reference-to-video' || selectedModel.kind === 'kling3-reference-to-video' || selectedModel.kind === 'kling3-video-to-video') &&
            selectedModel.usesImageUrls !== false;

        if (shouldProcessImageUrls) {
            if (Array.isArray(image_urls)) {
                for (const u of image_urls) {
                    if (typeof u === 'string' && u) uploadedImageUrls.push(u);
                }
            }

            if (typeof image_url === 'string' && image_url) {
                if (!uploadedImageUrls.includes(image_url)) {
                    uploadedImageUrls.unshift(image_url);
                }
            }

            if (Array.isArray(imageFiles) && imageFiles.length > 0) {
                for (const img of imageFiles) {
                    const u = await uploadToFal(img.buffer, img.filename, img.mimeType);
                    uploadedImageUrls.push(u);
                }
            }

            if (selectedModel.kind === 'video-to-video' && uploadedImageUrls.length > 4) {
                return res.status(400).json({ error: 'Maximum 4 reference images allowed' });
            }

            if (selectedModel.kind === 'reference-to-video' && !isSeedanceReferenceModel) {
                const maxRefImages = Number.isFinite(Number(selectedModel.maxImageUrls))
                    ? Number(selectedModel.maxImageUrls)
                    : 7;
                if (uploadedImageUrls.length > maxRefImages) {
                    return res.status(400).json({ error: `Maximum ${maxRefImages} images allowed for this model` });
                }
            }

            if (Array.isArray(elements) && elements.length > 0) {
                if (selectedModel.kind === 'video-to-video') {
                    // Kling O1 video-to-video reference: max 4 total (elements + image_urls)
                    if (elements.length + uploadedImageUrls.length > 4) {
                        return res.status(400).json({ error: 'Maximum 4 total (elements + reference images) allowed for this model' });
                    }
                }

                if (selectedModel.kind === 'reference-to-video') {
                    // Kling O1 reference-to-video: max 7 total (elements + reference images + start image).
                    // We cannot reliably detect which image is start vs reference here, so enforce elements + image_urls <= maxRefImages.
                    const maxRefImagesTotal = Number.isFinite(Number(selectedModel.maxImageUrls))
                        ? Number(selectedModel.maxImageUrls)
                        : 7;
                    if (elements.length + uploadedImageUrls.length > maxRefImagesTotal) {
                        return res.status(400).json({ error: `Maximum ${maxRefImagesTotal} total (elements + images) allowed for this model` });
                    }
                }
            }
        }

        const payload = {};
        // Handle Kling 3 prompt vs multi_prompt
        if (isKling3Model) {
            if (multi_prompt && Array.isArray(multi_prompt)) {
                payload.multi_prompt = multi_prompt;
            } else if (prompt) {
                payload.prompt = prompt;
            }
        } else if (prompt) {
            payload.prompt = prompt;
        }

        const mergedOptions = {
            duration,
            aspect_ratio,
            keep_audio,
            video_id,
            ...(options && typeof options === 'object' ? options : {}),
        };

        const allowedOptions = Array.isArray(selectedModel.allowedOptions) ? selectedModel.allowedOptions : [];
        const optionTypes = (selectedModel.optionTypes && typeof selectedModel.optionTypes === 'object') ? selectedModel.optionTypes : null;

        const numericKeys = new Set(
            allowedOptions.filter((key) => OPTION_DEFS[key] && OPTION_DEFS[key].type === 'number')
        );

        if (optionTypes) {
            for (const [k, t] of Object.entries(optionTypes)) {
                if (t === 'number') {
                    numericKeys.add(k);
                }
            }
        }

        if (supportsReferenceVideos && Array.isArray(video_urls)) {
            for (const u of video_urls) {
                if (typeof u === 'string' && u) uploadedVideoUrls.push(u);
            }
        }

        if (supportsReferenceAudios && Array.isArray(audio_urls)) {
            for (const u of audio_urls) {
                if (typeof u === 'string' && u) uploadedAudioUrls.push(u);
            }
        }

        if (isSeedanceReferenceModel) {
            const maxImageUrls = Number.isFinite(Number(selectedModel.maxImageUrls)) ? Number(selectedModel.maxImageUrls) : 9;
            const maxVideoUrls = Number.isFinite(Number(selectedModel.maxVideoUrls)) ? Number(selectedModel.maxVideoUrls) : 3;
            const maxAudioUrls = Number.isFinite(Number(selectedModel.maxAudioUrls)) ? Number(selectedModel.maxAudioUrls) : 3;
            const maxTotalReferences = Number.isFinite(Number(selectedModel.maxTotalReferences)) ? Number(selectedModel.maxTotalReferences) : 12;
            const totalReferences = uploadedImageUrls.length + uploadedVideoUrls.length + uploadedAudioUrls.length;

            if (uploadedImageUrls.length > maxImageUrls) {
                return res.status(400).json({ error: `Maximum ${maxImageUrls} reference images allowed for this model` });
            }
            if (uploadedVideoUrls.length > maxVideoUrls) {
                return res.status(400).json({ error: `Maximum ${maxVideoUrls} reference videos allowed for this model` });
            }
            if (uploadedAudioUrls.length > maxAudioUrls) {
                return res.status(400).json({ error: `Maximum ${maxAudioUrls} reference audio files allowed for this model` });
            }
            if (totalReferences > maxTotalReferences) {
                return res.status(400).json({ error: `Maximum ${maxTotalReferences} total reference files allowed for this model` });
            }
            if (uploadedAudioUrls.length > 0 && uploadedImageUrls.length === 0 && uploadedVideoUrls.length === 0) {
                return res.status(400).json({ error: 'Audio references require at least one image or video reference for this model' });
            }
        }

        for (const k of numericKeys) {
            const v = mergedOptions[k];
            if (typeof v === 'undefined' || v === null || v === '') continue;

            const n = (typeof v === 'number') ? v : Number(v);
            if (!Number.isFinite(n)) {
                return res.status(400).json({ error: `${k} must be a number` });
            }
            mergedOptions[k] = n;
        }

        for (const k of allowedOptions) {
            if (typeof mergedOptions[k] === 'undefined' || mergedOptions[k] === null || mergedOptions[k] === '') continue;
            const payloadKey = OPTION_KEY_ALIASES[k] || k;
            payload[payloadKey] = mergedOptions[k];
        }
        let elementsForPayload = Array.isArray(elements) ? elements : [];
        if (selectedModel.kind === 'kling3-motion-control') {
            const orientation = (typeof payload.character_orientation === 'string' && payload.character_orientation)
                ? payload.character_orientation
                : ((typeof mergedOptions.character_orientation_kling3_motion === 'string' && mergedOptions.character_orientation_kling3_motion)
                    ? mergedOptions.character_orientation_kling3_motion
                    : 'video');

            if (orientation !== 'video') {
                elementsForPayload = [];
            } else {
                elementsForPayload = elementsForPayload
                    .filter((el) => el && typeof el === 'object' && !Array.isArray(el))
                    .slice(0, 1)
                    .map((el) => {
                        const normalized = {};
                        if (typeof el.frontal_image_url === 'string' && el.frontal_image_url) {
                            normalized.frontal_image_url = el.frontal_image_url;
                        }
                        if (Array.isArray(el.reference_image_urls)) {
                            const refs = el.reference_image_urls
                                .filter((u) => typeof u === 'string' && u)
                                .slice(0, 3);
                            if (refs.length > 0) {
                                normalized.reference_image_urls = refs;
                            }
                        }
                        return normalized;
                    })
                    .filter((el) => Object.keys(el).length > 0);
            }
        }

        if (selectedModel.kind === 'video-id-to-video') {
            payload.video_id = video_id;
        }

        if (finalVideoUrl) {
            payload.video_url = finalVideoUrl;
        }


        if (selectedModel.kind === 'motion-control' || selectedModel.kind === 'kling3-motion-control') {
            if (finalImageUrl) {
                payload.image_url = finalImageUrl;
            }
        }

        if (selectedModel.kind === 'image-to-video' || selectedModel.kind === 'audio-to-video' || selectedModel.kind === 'kling3-image-to-video' || selectedModel.kind === 'kling3-reference-to-video') {
            if (finalImageUrl) {
                if (selectedModel.startImageParam === 'start_image_url') {
                    payload.start_image_url = finalImageUrl;
                } else {
                    payload.image_url = finalImageUrl;
                }
            }

            if (selectedModel.supportsEndImage) {
                let endUrl =
                    (typeof end_image_url === 'string' && end_image_url) ? end_image_url
                        : ((typeof tail_image_url === 'string' && tail_image_url) ? tail_image_url : null);

                if (!endUrl && endImageFile) {
                    endUrl = await uploadToFal(endImageFile.buffer, endImageFile.filename, endImageFile.mimeType);
                }

                if (endUrl) {
                    if (selectedModel.endImageParam === 'tail_image_url') {
                        payload.tail_image_url = endUrl;
                    } else if (selectedModel.endImageParam === 'end_image_url') {
                        payload.end_image_url = endUrl;
                    } else {
                        payload.end_image_url = endUrl;
                    }
                }
            }
        }

        if ((selectedModel.kind === 'video-to-video' || selectedModel.kind === 'reference-to-video' || selectedModel.kind === 'kling3-reference-to-video' || selectedModel.kind === 'kling3-video-to-video') && selectedModel.usesImageUrls !== false) {
            if (uploadedImageUrls.length > 0) {
                payload.image_urls = uploadedImageUrls;
            }

            if (Array.isArray(elementsForPayload) && elementsForPayload.length > 0) {
                payload.elements = elementsForPayload;
            }
        }

        if (supportsReferenceVideos && uploadedVideoUrls.length > 0) {
            payload.video_urls = uploadedVideoUrls;
        }

        if (supportsReferenceAudios && uploadedAudioUrls.length > 0) {
            payload.audio_urls = uploadedAudioUrls;
        }

        // Handle Kling 3 elements for image-to-video and motion-control
        if (selectedModel.supportsElements && Array.isArray(elementsForPayload) && elementsForPayload.length > 0) {
            payload.elements = elementsForPayload;
        }

        let response = null;
        if (FAL_API_KEY) {
            response = await fetch(selectedModel.endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Key ${FAL_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload)
            });
        }

        if (!response || !response.ok) {
            const errorText = response ? await response.text() : 'FAL_KEY environment variable not configured';
            console.error('FAL API Error:', errorText);
            let parsed;
            try {
                parsed = JSON.parse(errorText);
            } catch {
                parsed = null;
            }

            const message = (parsed && (parsed.error || parsed.message))
                ? (parsed.error || parsed.message)
                : `FAL API error: ${response ? response.status : 500} ${response ? response.statusText : 'missing API key'}`;

            const googleFallback = await generateGoogleVideoFallback(model_id, payload).catch((fallbackError) => {
                console.error('Google video fallback error:', fallbackError);
                return { error: fallbackError.message || 'Google fallback failed' };
            });
            if (googleFallback && !googleFallback.error) {
                return res.status(200).json(googleFallback);
            }

            return res.status(response ? response.status : 500).json({
                error: googleFallback && googleFallback.error ? googleFallback.error : message,
                details: parsed || errorText,
            });
        }

        const data = await response.json();
        const requestId = data.request_id || data.requestId || data.id || null;

        const statusUrl = data.status_url || (requestId ? `${selectedModel.endpoint}/requests/${requestId}/status` : null);
        const responseUrl = data.response_url || (requestId ? `${selectedModel.endpoint}/requests/${requestId}` : null);

        if (!statusUrl) {
            return res.status(502).json({
                error: 'FAL API returned no status_url',
                details: data,
            });
        }

        // Return the request ID and status URLs
        return res.status(200).json({
            request_id: requestId,
            status_url: statusUrl,
            response_url: responseUrl,
        });

    } catch (error) {
        console.error('Video generation error:', error);
        return res.status(500).json({
            error: error.message || 'Internal server error'
        });
    }
}

module.exports.config = config;
module.exports.VIDEO_MODELS = VIDEO_MODELS;
module.exports.OPTION_DEFS = OPTION_DEFS;




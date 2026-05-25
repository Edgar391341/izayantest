// Updated function for handling image creation
async function handleCreateImage() {
    const modelId = 'gpt-image-2'; // Use gpt-image-2 model
    const prompt = 'Введите ваш текст'; // Get text from user
    const body = {
        model_id: modelId,
        prompt: prompt,
        output_format: 'png',
        resolution: '1K',
    };
    try {
        const result = await submitKieImageTask(body);
        console.log('Image created successfully:', result);
    } catch (error) {
        console.error('Error creating image:', error);
    }
}
window.handleCreateImage = handleCreateImage;

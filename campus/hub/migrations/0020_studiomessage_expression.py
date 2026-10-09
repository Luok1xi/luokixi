from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('hub', '0019_question_workshop')]
    operations = [migrations.AddField(
        model_name='studiomessage', name='expression',
        field=models.CharField(default='neutral', max_length=16),
    )]
